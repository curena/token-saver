import { describe, expect, it } from "vitest";
import { applyDecisions, runSweep } from "../src/sweep.js";
import type { SweepInput } from "../src/sweep.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";
import type { JevClient } from "../src/judge.js";

const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function bigRead(id: string, path: string, messageIndex: number): ResultRef {
  const text = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");
  return {
    id, toolName: "read", input: { path }, text,
    tokens: Math.ceil(text.length / 4), messageIndex, turnsAgo: 6, isError: false,
  };
}

function allStale(): JevClient {
  return { systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.02 };
    return { answers };
  } };
}

function input(over: Partial<SweepInput> = {}): SweepInput {
  const results = over.results ?? [bigRead("a", "src/app.ts", 10), bigRead("b", "src/other.ts", 12)];
  return {
    results,
    decided: new Map(),
    touches: [],
    task: { recent_user_messages: ["go"], latest_assistant_text: "", working_files: [] },
    afterResultFor: () => "",
    // A realistic suffix: the results themselves plus a small tail. The cost gate
    // weighs the saving against what a rewrite re-caches, so an arbitrarily large
    // suffix would make every sweep in these tests look unaffordable.
    tokensAfter: (messageIndex) =>
      results.filter((r) => r.messageIndex >= messageIndex).reduce((sum, r) => sum + r.tokens, 0) + 300,
    callsSoFar: 40,
    prices: PRICES,
    config: DEFAULT_CONFIG,
    client: allStale(),
    currentTurn: 9,
    trigger: "cost",
    ...over,
  };
}

describe("runSweep", () => {
  it("stubs stale results and reports the saving", async () => {
    const outcome = await runSweep(input());
    expect(outcome.reason).toBe("swept");
    expect(outcome.decisions.map((d) => d.level)).toEqual(["stub", "stub"]);
    expect(outcome.savedTokens).toBeGreaterThan(3000);
    expect(outcome.decisions[0]!.rendered).toContain("[token-saver]");
    expect(outcome.decisions[0]!.decidedAtTurn).toBe(9);
    expect(outcome.jevInputTokens).toBeGreaterThan(0);
    expect(Object.keys(outcome.probabilitiesById)).toEqual(["a", "b"]);
  });

  it("stubs a superseded read without calling Jev", async () => {
    let calls = 0;
    const client: JevClient = { systemOne: async () => { calls++; return { answers: {} }; } };
    const outcome = await runSweep(input({
      results: [bigRead("a", "src/app.ts", 10)],
      touches: [{ path: "src/app.ts", messageIndex: 14, kind: "edit" }],
      client,
    }));
    expect(calls).toBe(0);
    expect(outcome.jevRequests).toBe(0);
    expect(outcome.decisions[0]).toMatchObject({ level: "stub", reason: "superseded" });
  });

  it("keeps relevant chunks as a partial", async () => {
    const client: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      Object.keys(request.questions).forEach((key, i) => { answers[key] = { noul: i === 0 ? 0.95 : 0.02 }; });
      return { answers };
    } };
    const outcome = await runSweep(input({ results: [bigRead("a", "src/app.ts", 10)], client }));
    expect(outcome.decisions[0]!.level).toBe("partial");
    expect(outcome.decisions[0]!.rendered).toContain("elided …");
  });

  it("does nothing when the cost gate refuses", async () => {
    const outcome = await runSweep(input({ tokensAfter: () => 900_000, callsSoFar: 3 }));
    expect(outcome.reason).toBe("gate");
    expect(outcome.decisions).toEqual([]);
  });

  it("discards decisions when the real saving fails the gate", async () => {
    // Jev keeps everything, so actual savings are zero and the post-gate refuses.
    const client: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
      return { answers };
    } };
    const outcome = await runSweep(input({ client }));
    expect(outcome.reason).toBe("post-gate");
    expect(outcome.decisions).toEqual([]);
  });

  it("changes nothing when Jev fails", async () => {
    const client: JevClient = { systemOne: async () => { throw new Error("boom"); } };
    const outcome = await runSweep(input({ client }));
    expect(outcome.reason).toBe("judge-failed");
    expect(outcome.decisions).toEqual([]);
  });

  it("ignores the pre-gate for the context trigger", async () => {
    const outcome = await runSweep(input({ trigger: "context", tokensAfter: () => 900_000, callsSoFar: 3 }));
    expect(outcome.reason).toBe("swept");
  });

  it("reports no candidates when everything is protected", async () => {
    const outcome = await runSweep(input({ results: [bigRead("a", "src/app.ts", 10)].map((r) => ({ ...r, turnsAgo: 0 })) }));
    expect(outcome.reason).toBe("no-candidates");
  });
});

describe("applyDecisions", () => {
  it("replaces text for stub and partial decisions and leaves the rest", () => {
    const decided = new Map<string, Decision>([
      ["a", { id: "a", level: "stub", rendered: "STUB", savedTokens: 9000, reason: "judged", keptChunks: [], decidedAtTurn: 2 }],
      ["b", { id: "b", level: "leave", rendered: null, savedTokens: 0, reason: "judged", keptChunks: [], decidedAtTurn: 2 }],
    ]);
    const out = applyDecisions([{ id: "a", text: "long" }, { id: "b", text: "keep" }, { id: "c", text: "untouched" }], decided);
    expect(out).toEqual([{ id: "a", text: "STUB" }, { id: "b", text: "keep" }, { id: "c", text: "untouched" }]);
  });

  it("does not mutate its input", () => {
    const messages = [{ id: "a", text: "long" }];
    const decided = new Map<string, Decision>([
      ["a", { id: "a", level: "stub", rendered: "STUB", savedTokens: 1, reason: "judged", keptChunks: [], decidedAtTurn: 1 }],
    ]);
    applyDecisions(messages, decided);
    expect(messages[0]!.text).toBe("long");
  });
});
