import { describe, expect, it } from "vitest";
import { expectedCalls, planCostGate } from "../src/policy/cost.js";
import type { CostInput } from "../src/policy/cost.js";

// Anthropic-shaped per-token prices (per Mtok: $3 input, $0.30 cache read, $3.75 cache write).
const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function input(over: Partial<CostInput> = {}): CostInput {
  return {
    candidates: [{ id: "a", messageIndex: 10, expectedSave: 40_000 }],
    tokensAfter: () => 50_000,
    callsSoFar: 20,
    prices: PRICES,
    costMargin: 1.5,
    ...over,
  };
}

describe("expectedCalls", () => {
  it("clamps to between 3 and 40", () => {
    expect(expectedCalls(0)).toBe(3);
    expect(expectedCalls(12)).toBe(12);
    expect(expectedCalls(400)).toBe(40);
  });
});

describe("planCostGate", () => {
  it("sweeps when large results sit behind a short suffix", () => {
    const plan = planCostGate(input());
    expect(plan.sweep).toBe(true);
    expect(plan.ids).toEqual(["a"]);
    expect(plan.fromIndex).toBe(10);
  });

  it("does not sweep when the saving is small behind a long suffix", () => {
    const plan = planCostGate(input({
      candidates: [{ id: "a", messageIndex: 4, expectedSave: 20_000 }],
      tokensAfter: () => 60_000,
      callsSoFar: 15,
    }));
    expect(plan.sweep).toBe(false);
  });

  it("prefers a later starting point when the early candidate drags in a long suffix", () => {
    const plan = planCostGate(input({
      candidates: [
        { id: "early", messageIndex: 2, expectedSave: 1_600 },
        { id: "late", messageIndex: 30, expectedSave: 40_000 },
      ],
      tokensAfter: (index) => (index <= 2 ? 200_000 : 45_000),
    }));
    expect(plan.sweep).toBe(true);
    expect(plan.ids).toEqual(["late"]);
    expect(plan.fromIndex).toBe(30);
  });

  it("uses the floor instead of the cache maths when the provider has no caching", () => {
    const noCache = { prices: null, candidates: [{ id: "a", messageIndex: 10, expectedSave: 4_000 }] };
    expect(planCostGate(input(noCache)).sweep).toBe(true);
    expect(planCostGate(input({ ...noCache, candidates: [{ id: "a", messageIndex: 10, expectedSave: 3_999 }] })).sweep)
      .toBe(false);
  });

  it("does not sweep with no candidates", () => {
    const plan = planCostGate(input({ candidates: [] }));
    expect(plan.sweep).toBe(false);
    expect(plan.ids).toEqual([]);
  });

  it("respects a stricter margin", () => {
    expect(planCostGate(input({ costMargin: 100 })).sweep).toBe(false);
  });
});
