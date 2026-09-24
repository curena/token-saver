import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DecisionStore, SWEEP_ENTRY } from "../src/state.js";
import type { Decision } from "@token-saver/core";

function decision(id: string): Decision {
  return { id, level: "stub", rendered: `[token-saver] ${id}`, savedTokens: 1000, reason: "judged", keptChunks: [], decidedAtTurn: 1 };
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as any;
const result = (id: string) =>
  ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "x" }], isError: false, timestamp: 0 }) as any;

describe("rebuildFrom with pi's compaction-aware context entries", () => {
  it("keeps decisions for results in the kept tail, shortened just before compacting", () => {
    const session = SessionManager.inMemory("/tmp");
    session.appendMessage(user("one"));
    session.appendMessage(result("old"));
    const firstKept = session.appendMessage(user("two"));
    session.appendMessage(result("tail"));
    session.appendCustomEntry(SWEEP_ENTRY, { decisions: [decision("old"), decision("tail")], trigger: "cost", at: "t" });
    session.appendCompaction("summary", firstKept, 1000);
    session.appendCustomEntry(SWEEP_ENTRY, { decisions: [decision("fresh")], trigger: "cost", at: "t" });

    const store = new DecisionStore();
    store.rebuildFrom(session.buildContextEntries() as any);
    expect(store.get().has("tail")).toBe(true);
    expect(store.get().has("fresh")).toBe(true);
  });
});
