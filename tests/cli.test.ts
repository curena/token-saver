import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

/**
 * Every regular file under `dir`, keyed by its path relative to `dir`, mapped to its
 * contents. Used to prove a call made no filesystem changes: snapshot before, snapshot
 * after, assert they're deepEqual. A byte-for-byte content diff catches truncation and
 * silent rewrites that an existence check or mtime comparison would miss.
 */
function snapshot(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath ?? (entry as any).path, entry.name);
    const rel = abs.slice(dir.length + 1);
    out[rel] = readFileSync(abs, "utf8");
  }
  return out;
}

// Mocked ahead of any import of "@typesafe-ai/sdk" so `makeJev`'s dynamic import in
// src/cli.ts resolves to this fake client instead of a real one. `vi.hoisted` is required
// here (rather than a plain module-scope const) because `vi.mock` factories are hoisted
// above the rest of the file, so anything they close over must be created through
// `vi.hoisted` to exist by the time the factory itself runs.
// `fitQuestions` (src/core/questions/fit.ts) also imports the real `score` builder from
// this same package unconditionally, so the mock must keep every other export intact via
// `importOriginal` and only replace `TypeSafeClient`.
const { mockSystemOne } = vi.hoisted(() => ({ mockSystemOne: vi.fn() }));
vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  return {
    ...actual,
    TypeSafeClient: vi.fn().mockImplementation(() => ({ systemOne: mockSystemOne })),
  };
});

let home: string;
let project: string;
let out: string[];
let err: string[];

function addSkill(name: string, description: string) {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ts-home-"));
  project = mkdtempSync(join(tmpdir(), "ts-proj-"));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  process.env.TOKEN_SAVER_HOME = home;
  process.env.TOKEN_SAVER_ROOT = project;
  delete process.env.TYPESAFE_API_KEY;
  mockSystemOne.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.TOKEN_SAVER_HOME;
  delete process.env.TOKEN_SAVER_ROOT;
  delete process.env.TYPESAFE_API_KEY;
});

describe("cli", () => {
  it("prints usage and exits non-zero for an unknown command", async () => {
    expect(await main(["wat"])).toBe(1);
    expect(out.join("\n")).toMatch(/usage/i);
  });

  it("audits with no API key and proposes nothing, without failing", async () => {
    addSkill("pdf", "PDFs");
    expect(await main(["audit"])).toBe(0);
    expect(out.join("\n")).toMatch(/no changes/i);
  });

  it("session-start prints nothing when the fingerprint is unchanged", async () => {
    addSkill("pdf", "PDFs");
    await main(["audit"]); // writes the first fingerprint
    out.length = 0;
    expect(await main(["hook", "session-start"])).toBe(0);
    expect(out.join("")).toBe("");
  });

  it("session-start emits a systemMessage after the setup changes", async () => {
    addSkill("pdf", "PDFs");
    await main(["audit"]);
    addSkill("new-skill", "Fresh");
    out.length = 0;
    expect(await main(["hook", "session-start"])).toBe(0);
    expect(JSON.parse(out.join("")).systemMessage).toMatch(/token-saver audit/);
  });

  it("session-start is provably inert on a project that has never been audited", async () => {
    addSkill("pdf", "PDFs");
    // No prior `audit` call: this project has no fingerprint and no .token-saver/ at all yet.

    expect(await main(["hook", "session-start"])).toBe(0);
    // Nothing to compare against, so nothing is printed...
    expect(out.join("")).toBe("");
    // ...and, critically, no state was created as a side effect of checking. This is the
    // exact case the fingerprint-mkdirSync bug hid in: reading through `Store.dir()`
    // unconditionally creates `.token-saver/audit/` even when there's no fingerprint to
    // read, so a naive `store.readFingerprint()` call here would fail this assertion.
    expect(existsSync(join(project, ".token-saver"))).toBe(false);
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
  });

  it("session-start is provably inert post-audit too: it writes nothing, even when it detects drift", async () => {
    addSkill("pdf", "PDFs");
    await main(["audit"]); // establishes a baseline fingerprint and a settings dir to watch
    addSkill("new-skill", "Fresh"); // drift, so session-start has something to report

    const before = { project: snapshot(project), home: snapshot(home) };
    out.length = 0;
    expect(await main(["hook", "session-start"])).toBe(0);
    // It does detect the drift (proves this run actually exercised the interesting path)...
    expect(JSON.parse(out.join("")).systemMessage).toMatch(/token-saver audit/);
    // ...but every file under both trees is byte-for-byte identical to before the call,
    // and nothing new was created: no settings.local.json, no new fingerprint, no audit log.
    const after = { project: snapshot(project), home: snapshot(home) };
    expect(after).toEqual(before);
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
  });

  it("rejects --apply combined with --undo instead of silently picking one", async () => {
    addSkill("pdf", "PDFs");
    expect(await main(["audit", "--apply", "--undo"])).toBe(1);
    expect(err.join("\n")).toMatch(/usage/i);
    expect(err.join("\n")).toMatch(/--apply/);
    expect(err.join("\n")).toMatch(/--undo/);
    // Nothing should have been written or reverted: the conflict is rejected before any
    // settings or audit-log work happens.
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(project, ".token-saver"))).toBe(false);
  });

  it("rejects an unrecognized flag on audit", async () => {
    addSkill("pdf", "PDFs");
    expect(await main(["audit", "--frobnicate"])).toBe(1);
    expect(err.join("\n")).toMatch(/usage/i);
    expect(err.join("\n")).toMatch(/--frobnicate/);
    expect(out.join("\n")).not.toMatch(/no changes/i); // never got as far as running the audit
  });

  it("warns on stderr and still exits 0 when every fit judgment fails", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    mockSystemOne.mockRejectedValue(new Error("simulated Jev failure"));
    addSkill("pdf", "PDFs");

    expect(await main(["audit"])).toBe(0);
    expect(err.join("\n")).toMatch(/1 of 1 fit judgment/i);
    expect(err.join("\n")).toMatch(/unavailable/i);
    expect(err.join("\n")).toMatch(/usage data alone/i);
    // Fail-open still produces actionable output, not silence.
    expect(out.join("\n").length).toBeGreaterThan(0);
  });
});
