import { describe, expect, it } from "vitest";
import { selectEligible } from "../src/policy/eligibility.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";

function ref(over: Partial<ResultRef> = {}): ResultRef {
  return {
    id: "call_1",
    toolName: "read",
    input: { path: "src/app.ts" },
    text: "x".repeat(40_000),
    tokens: 10_000,
    messageIndex: 4,
    turnsAgo: 5,
    isError: false,
    ...over,
  };
}

const none = new Map<string, Decision>();

describe("selectEligible", () => {
  it("accepts a large, old, undecided result", () => {
    expect(selectEligible([ref()], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("protects results from the last protectTurns turns", () => {
    expect(selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ turnsAgo: 3 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("honours a relaxed minTurnsAgo for the context-limit trigger", () => {
    const relaxed = selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG, {
      minTurnsAgo: 1,
    });
    expect(relaxed).toHaveLength(1);
  });

  it("skips results under minResultTokens", () => {
    expect(selectEligible([ref({ tokens: 1499 })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips errors", () => {
    expect(selectEligible([ref({ isError: true })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips excluded tools", () => {
    expect(selectEligible([ref({ toolName: "edit" })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "write" })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips results that already have a decision", () => {
    const decided = new Map<string, Decision>([
      ["call_1", {
        id: "call_1", level: "stub", rendered: "[token-saver] ...",
        savedTokens: 9000, reason: "judged", keptChunks: [], decidedAtTurn: 3,
      }],
    ]);
    expect(selectEligible([ref()], decided, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips recall output from the protected window but not older recalls", () => {
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 9 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });
});
