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

let home: string;
let project: string;
let out: string[];

function addSkill(name: string, description: string) {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ts-home-"));
  project = mkdtempSync(join(tmpdir(), "ts-proj-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  process.env.TOKEN_SAVER_HOME = home;
  process.env.TOKEN_SAVER_ROOT = project;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.TOKEN_SAVER_HOME;
  delete process.env.TOKEN_SAVER_ROOT;
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

  it("session-start is provably inert: it writes nothing, even when it detects drift", async () => {
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
});
