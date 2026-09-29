import type { Prices } from "../types.js";

export interface CostCandidate {
  id: string;
  messageIndex: number;
  expectedSave: number;
}

export interface CostInput {
  candidates: CostCandidate[];
  tokensAfter: (messageIndex: number) => number;
  callsSoFar: number;
  prices: Prices | null;
  costMargin: number;
  noCacheFloor?: number;
}

export interface CostPlan {
  sweep: boolean;
  fromIndex: number;
  ids: string[];
  value: number;
  cost: number;
}

const NONE: CostPlan = { sweep: false, fromIndex: -1, ids: [], value: 0, cost: 0 };

function usableCaching(prices: Prices | null): prices is Prices {
  return prices !== null && prices.cacheRead >= 0 && prices.cacheWrite > prices.cacheRead;
}

export function expectedCalls(callsSoFar: number): number {
  return Math.min(40, Math.max(3, callsSoFar));
}

export function planCostGate(input: CostInput): CostPlan {
  const { candidates, prices, costMargin } = input;
  if (candidates.length === 0) return NONE;

  const sorted = [...candidates].sort((a, b) => a.messageIndex - b.messageIndex);

  // No usable prompt caching: nothing is re-written, so only the size of the
  // saving matters. A quote where writing is no dearer than reading is treated
  // as unusable rather than trusted — a negative `cacheWrite - cacheRead` would
  // make the cost negative and wave every sweep through.
  if (!usableCaching(prices)) {
    const saved = sorted.reduce((sum, candidate) => sum + candidate.expectedSave, 0);
    const floor = input.noCacheFloor ?? 4000;
    return saved >= floor
      ? { sweep: true, fromIndex: sorted[0]!.messageIndex, ids: sorted.map((c) => c.id), value: saved, cost: 0 }
      : NONE;
  }

  const calls = expectedCalls(input.callsSoFar);
  let best: CostPlan = NONE;
  let bestNet = 0;

  for (let start = 0; start < sorted.length; start++) {
    const taken = sorted.slice(start);
    const saved = taken.reduce((sum, candidate) => sum + candidate.expectedSave, 0);
    const fromIndex = taken[0]!.messageIndex;
    const suffix = input.tokensAfter(fromIndex);
    // A saving cannot exceed the suffix it comes out of. If the caller says
    // otherwise its numbers disagree, so believe the smaller one for both
    // sides of the gate rather than crediting a saving that cannot exist.
    const realised = Math.min(saved, Math.max(0, suffix));
    const value = realised * calls * prices.cacheRead;
    const cost = (suffix - realised) * (prices.cacheWrite - prices.cacheRead);
    const net = value - cost;
    if (value >= costMargin * cost && net > bestNet) {
      bestNet = net;
      best = { sweep: true, fromIndex, ids: taken.map((c) => c.id), value, cost };
    }
  }
  return best;
}
