import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProposals, buildProposals, judgeFit, renderProposals, undoLast } from "../../src/audit/run.js";
import { Jev } from "../../src/runtime/jev.js";
import { Store } from "../../src/runtime/store.js";
import type { FitLevel, InventoryItem, ProjectProfile } from "../../src/core/types.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-run-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const profile: ProjectProfile = { root: "/p", readme: "A TypeScript CLI", manifests: [], tree: [], prompts: [] };

function item(id: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id, name: id, kind: "skill", harness: "claude-code", source: `/s/${id}`,
    description: `${id} things`, tokens: 30, managed: true, currentState: "on", ...over,
  };
}

describe("judgeFit", () => {
  it("asks in batches of 20 and merges the answers", async () => {
    const batches: number[] = [];
    const client = {
      systemOne: async (req: any) => {
        const keys = Object.keys(req.questions);
        batches.push(keys.length);
        // score: 3 is the worst-fit rubric index (0-based), which levelForIndex maps to
        // FitLevel 4 ("irrelevant"). The brief's literal test used the string label
        // "irrelevant" here, but parseFit requires a finite numeric score (see
        // src/core/questions/fit.ts) and silently skips anything else -- fixed to use the
        // numeric index that produces the same intended level.
        return { answers: Object.fromEntries(keys.map((k) => [k, { score: 3, confidence: 0.8 }])) };
      },
    };
    const items = Array.from({ length: 25 }, (_, i) => item(`s${i}`));
    const fits = await judgeFit(new Jev({ client }), profile, items);
    expect(batches).toEqual([20, 5]);
    expect(fits.size).toBe(25);
    expect(fits.get("s0")).toBe(4);
  });

  it("returns an empty map when Jev fails, so nothing is proposed", async () => {
    const jev = new Jev({ client: { systemOne: async () => { throw new Error("down"); } } });
    expect((await judgeFit(jev, profile, [item("pdf")])).size).toBe(0);
  });

  it("carries on when only some batches fail open (fail-open mix)", async () => {
    let call = 0;
    const client = {
      systemOne: async (req: any) => {
        call += 1;
        const keys = Object.keys(req.questions);
        if (call === 1) throw new Error("down for this batch");
        return { answers: Object.fromEntries(keys.map((k) => [k, { score: 0, confidence: 0.9 }])) };
      },
    };
    const items = Array.from({ length: 25 }, (_, i) => item(`s${i}`));
    const fits = await judgeFit(new Jev({ client }), profile, items);
    // First batch (20 items) failed open; second batch (5 items) succeeded.
    expect(fits.size).toBe(5);
    expect(fits.get("s20")).toBe(1);
    expect(fits.has("s0")).toBe(false);
  });
});

describe("buildProposals", () => {
  it("returns only items whose state would change", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4], ["cli", 1]]);
    const proposals = buildProposals([item("pdf"), item("cli")], fits, new Map());
    expect(proposals.map((p) => p.id)).toEqual(["pdf"]);
    expect(proposals[0].to).toBe("user-invocable-only");
  });

  it("keeps a used skill on even when its fit is low", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    expect(buildProposals([item("pdf")], fits, new Map([["pdf", 2]]))).toHaveLength(0);
  });
});

describe("renderProposals", () => {
  it("shows each change and the total token saving", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const text = renderProposals(buildProposals([item("pdf")], fits, new Map()));
    expect(text).toContain("pdf");
    expect(text).toContain("user-invocable-only");
    expect(text).toMatch(/30 tokens/);
  });

  it("says so when there is nothing to change", () => {
    expect(renderProposals([])).toMatch(/no changes/i);
  });
});

describe("applyProposals and undoLast", () => {
  it("writes skillOverrides and records the previous values", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, JSON.stringify({ skillOverrides: { cli: "on" }, other: 1 }), "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(count).toBe(1);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written.skillOverrides).toEqual({ cli: "on", pdf: "user-invocable-only" });
    expect(written.other).toBe(1);
    expect(store.lastAudit()?.previous).toEqual({});
  });

  it("creates the settings file when it does not exist", () => {
    const settings = join(root, "settings.local.json");
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, new Store(root), new Date());
    expect(existsSync(settings)).toBe(true);
  });

  it("creates the settings file's parent directory when it does not yet exist", () => {
    // Simulates a fresh machine: ~/.claude does not exist yet.
    const settings = join(root, "nested", "does", "not", "exist", "settings.local.json");
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, new Store(root), new Date());
    expect(count).toBe(1);
    expect(existsSync(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
  });

  it("restores the previous state on undo", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, JSON.stringify({ skillOverrides: { pdf: "name-only" } }), "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(
      buildProposals([item("pdf", { currentState: "name-only" })], fits, new Map()),
      settings, store, new Date(),
    );
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
    undoLast(store);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("name-only");
  });

  it("removes a key that did not exist before the apply", () => {
    const settings = join(root, "settings.local.json");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    undoLast(store);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides).toEqual({});
  });

  it("reports when there is nothing to undo", () => {
    expect(undoLast(new Store(root))).toMatch(/nothing/i);
  });

  it("does not throw when undoLast is called twice in a row", () => {
    const settings = join(root, "settings.local.json");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(() => undoLast(store)).not.toThrow();
    // Second undo: the revert itself was recorded, so this undoes the revert (idempotent-safe, not a throw).
    expect(() => undoLast(store)).not.toThrow();
  });

  it("leaves the settings file untouched when appendAudit throws (order-of-operations)", () => {
    const settings = join(root, "settings.local.json");
    const before = JSON.stringify({ skillOverrides: { cli: "on" } });
    writeFileSync(settings, before, "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const proposals = buildProposals([item("pdf")], fits, new Map());
    // Force appendAudit to throw by poisoning the previous value it would record for "cli":
    // Object.defineProperty on the overrides isn't reachable from here, so instead we stub
    // store.appendAudit directly to simulate any internal failure (disk full, EACCES, etc.).
    const originalAppend = store.appendAudit.bind(store);
    store.appendAudit = () => { throw new Error("boom"); };
    expect(() => applyProposals(proposals, settings, store, new Date())).toThrow("boom");
    expect(readFileSync(settings, "utf8")).toBe(before);
    store.appendAudit = originalAppend;
  });

  it("treats a malformed (non-JSON) settings file as empty and still applies", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, "{not valid json", "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(count).toBe(1);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
  });

  it("treats a settings file that is valid JSON but not an object as empty", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, "[]", "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(count).toBe(1);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
  });

  it("treats a skillOverrides value that is not an object as empty overrides", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, JSON.stringify({ skillOverrides: "not-an-object" }), "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(count).toBe(1);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
  });
});
