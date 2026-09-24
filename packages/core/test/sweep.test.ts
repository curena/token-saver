import { describe, expect, it } from "vitest";
import { applyDecisions, runSweep } from "../src/sweep.js";
import type { SweepInput } from "../src/sweep.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";
import type { JevClient } from "../src/judge.js";

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
    currentTokens: 80_000,
    targetTokens: 30_000,
    config: DEFAULT_CONFIG,
    client: allStale(),
    currentTurn: 9,
    trigger: "turn",
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

  it("changes nothing when Jev fails", async () => {
    const client: JevClient = { systemOne: async () => { throw new Error("boom"); } };
    const outcome = await runSweep(input({ client }));
    expect(outcome.reason).toBe("judge-failed");
    expect(outcome.decisions).toEqual([]);
    expect(outcome.reached).toBe(80_000);
  });

  it("reports no candidates when everything is protected", async () => {
    const outcome = await runSweep(input({ results: [bigRead("a", "src/app.ts", 10)].map((r) => ({ ...r, turnsAgo: 0 })) }));
    expect(outcome.reason).toBe("no-candidates");
  });

  it("does nothing when already at target", async () => {
    const outcome = await runSweep(input({ currentTokens: 25_000 }));
    expect(outcome.reason).toBe("at-target");
    expect(outcome.decisions).toEqual([]);
    expect(outcome.reached).toBe(25_000);
  });

  it("shortens only the newest result when that covers the need", async () => {
    const perResult = bigRead("x", "x.ts", 1).tokens;
    // expectedSaveRatio 0.5: one result's expected saving is enough.
    const outcome = await runSweep(input({ currentTokens: 30_000 + Math.floor(perResult * 0.4) }));
    expect(outcome.decisions.map((d) => d.id)).toEqual(["b"]);
    expect(outcome.fromIndex).toBe(12);
  });

  it("reports the tokens reached", async () => {
    const outcome = await runSweep(input());
    expect(outcome.reason).toBe("swept");
    expect(outcome.reached).toBe(80_000 - outcome.savedTokens);
    expect(outcome.fromIndex).toBe(10);
  });

  it("keeps superseded stubs when Jev fails", async () => {
    const failing: JevClient = { systemOne: async () => { throw new Error("down"); } };
    const outcome = await runSweep(input({
      client: failing,
      touches: [{ path: "src/app.ts", messageIndex: 20, kind: "edit" }],
    }));
    expect(outcome.reason).toBe("judge-failed");
    expect(outcome.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(outcome.decisions[0]!.reason).toBe("superseded");
  });

  it("reports nothing-shortened when Jev keeps everything", async () => {
    const keepAll: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
      return { answers };
    } };
    const outcome = await runSweep(input({ client: keepAll }));
    expect(outcome.reason).toBe("nothing-shortened");
    expect(outcome.decisions).toEqual([]);
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
