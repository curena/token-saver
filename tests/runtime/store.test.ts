import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../src/runtime/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("Store", () => {
  it("round-trips a cache", () => {
    const store = new Store(root);
    store.saveCache("fit", new Map<string, any>([["k", { a: 1 }]]));
    expect(new Store(root).loadCache("fit").get("k")).toEqual({ a: 1 });
  });

  it("returns an empty cache when none exists", () => {
    expect(new Store(root).loadCache("missing").size).toBe(0);
  });

  it("returns the most recent audit entry", () => {
    const store = new Store(root);
    store.appendAudit({ at: "2026-01-01T00:00:00Z", file: "a.json", previous: {}, applied: { x: "on" } });
    store.appendAudit({ at: "2026-01-02T00:00:00Z", file: "b.json", previous: { y: "on" }, applied: { y: "name-only" } });
    expect(store.lastAudit()?.file).toBe("b.json");
  });

  it("returns null when there is no audit history", () => {
    expect(new Store(root).lastAudit()).toBeNull();
  });

  it("round-trips a fingerprint", () => {
    const store = new Store(root);
    expect(store.readFingerprint()).toBeNull();
    store.writeFingerprint("abc123");
    expect(new Store(root).readFingerprint()).toBe("abc123");
  });

  it("returns the last parseable entry when a trailing line is truncated", () => {
    const store = new Store(root);
    store.appendAudit({ at: "2026-01-01T00:00:00Z", file: "a.json", previous: {}, applied: { x: "on" } });
    store.appendAudit({ at: "2026-01-02T00:00:00Z", file: "b.json", previous: { y: "on" }, applied: { y: "name-only" } });

    // Simulate truncation during append: write a partial JSON line at the end
    const auditDir = store.dir("audit");
    const logFile = join(auditDir, "log.jsonl");
    writeFileSync(logFile, readFileSync(logFile, "utf8") + '{"at":"2026-01-03', "utf8");

    // Should skip the truncated line and return the last good one
    expect(new Store(root).lastAudit()?.file).toBe("b.json");
  });

  it("returns null when the entire audit log is corrupt", () => {
    const store = new Store(root);
    const auditDir = store.dir("audit");
    const logFile = join(auditDir, "log.jsonl");

    // Write entirely invalid JSON
    writeFileSync(logFile, "not valid json at all\n{broken: incomplete\n", "utf8");

    // Should return null without throwing
    expect(new Store(root).lastAudit()).toBeNull();
  });

  it("rejects appendAudit with non-string values in previous", () => {
    const store = new Store(root);

    // Should throw when previous contains a non-string value
    expect(() => {
      store.appendAudit({
        at: "2026-01-01T00:00:00Z",
        file: "a.json",
        previous: { x: undefined as any }, // undefined will be caught
        applied: { x: "on" },
      });
    }).toThrow(/previous\[.*x.*\].*must be a string/);
  });
});
