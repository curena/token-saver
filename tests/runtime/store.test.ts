import { mkdtempSync, rmSync } from "node:fs";
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
});
