import { describe, expect, it } from "vitest";
import { DecisionStore, RESTORE_ENTRY, SWEEP_ENTRY } from "../src/state.js";
import type { Decision } from "@token-saver/core";

function decision(id: string, level: Decision["level"] = "stub"): Decision {
  return {
    id, level, rendered: level === "leave" ? null : `[token-saver] ${id}`,
    savedTokens: 1000, reason: "judged", keptChunks: [], decidedAtTurn: 1,
  };
}

describe("DecisionStore", () => {
  it("starts empty", () => {
    expect(new DecisionStore().get().size).toBe(0);
  });

  it("adds decisions and reports statistics", () => {
    const store = new DecisionStore();
    store.add([decision("a"), decision("b", "partial")]);
    expect(store.get().size).toBe(2);
    expect(store.stats()).toEqual({ stubbed: 1, partial: 1, savedTokens: 2000 });
  });

  it("never lets a later decision overwrite an existing one", () => {
    const store = new DecisionStore();
    store.add([decision("a")]);
    store.add([{ ...decision("a", "partial"), savedTokens: 99 }]);
    expect(store.get().get("a")!.level).toBe("stub");
    expect(store.stats().savedTokens).toBe(1000);
  });

  it("rebuilds from session entries, ignoring other custom types", () => {
    const store = new DecisionStore();
    store.rebuildFrom([
      { type: "custom", customType: "other", data: { decisions: [decision("z")] } },
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("a")], trigger: "cost", at: "t" } },
      { type: "message" },
    ]);
    expect([...store.get().keys()]).toEqual(["a"]);
  });

  it("drops decisions taken before the last compaction", () => {
    const store = new DecisionStore();
    store.rebuildFrom([
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("old")] } },
      { type: "compaction" },
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("fresh")] } },
    ]);
    expect([...store.get().keys()]).toEqual(["fresh"]);
  });

  it("survives malformed entry data", () => {
    const store = new DecisionStore();
    store.rebuildFrom([{ type: "custom", customType: SWEEP_ENTRY, data: { decisions: "nope" } }]);
    expect(store.get().size).toBe(0);
  });

  it("removes a decision for /token-saver restore", () => {
    const store = new DecisionStore();
    store.add([decision("a")]);
    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    expect(store.get().size).toBe(0);
  });

  it("restore pins the result as a leave decision so later sweeps skip it", () => {
    const store = new DecisionStore();
    store.add([decision("a")]);
    expect(store.restore("a")).toBe(true);
    const pinned = store.get().get("a")!;
    expect(pinned.level).toBe("leave");
    expect(pinned.rendered).toBeNull();
    expect(store.stats()).toEqual({ stubbed: 0, partial: 0, savedTokens: 0 });
    // A later sweep cannot re-shorten it: the first decision wins.
    store.add([decision("a")]);
    expect(store.get().get("a")!.level).toBe("leave");
  });

  it("restore reports false for unknown or already-restored ids", () => {
    const store = new DecisionStore();
    expect(store.restore("nope")).toBe(false);
    store.add([decision("a")]);
    expect(store.restore("a")).toBe(true);
    expect(store.restore("a")).toBe(false);
  });

  it("rebuild honors restore entries after the sweep that shortened the result", () => {
    const store = new DecisionStore();
    store.rebuildFrom([
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("a"), decision("b")] } },
      { type: "custom", customType: RESTORE_ENTRY, data: { id: "a" } },
      { type: "custom", customType: RESTORE_ENTRY, data: { id: 42 } },
    ]);
    expect(store.get().get("a")!.level).toBe("leave");
    expect(store.get().get("a")!.rendered).toBeNull();
    expect(store.get().get("b")!.level).toBe("stub");
  });
});
