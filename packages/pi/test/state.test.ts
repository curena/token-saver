import { describe, expect, it } from "vitest";
import { DecisionStore, SWEEP_ENTRY } from "../src/state.js";
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
});
