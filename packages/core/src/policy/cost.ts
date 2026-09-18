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

export function expectedCalls(callsSoFar: number): number {
  return Math.min(40, Math.max(3, callsSoFar));
}

export function planCostGate(input: CostInput): CostPlan {
  const { candidates, prices, costMargin } = input;
  if (candidates.length === 0) return NONE;

  const sorted = [...candidates].sort((a, b) => a.messageIndex - b.messageIndex);

  // No prompt caching: nothing is re-written, so only the size of the saving matters.
  if (prices === null || prices.cacheWrite <= 0) {
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
    const value = saved * calls * prices.cacheRead;
    const cost = Math.max(0, suffix - saved) * (prices.cacheWrite - prices.cacheRead);
    const net = value - cost;
    if (value >= costMargin * cost && net > bestNet) {
      bestNet = net;
      best = { sweep: true, fromIndex, ids: taken.map((c) => c.id), value, cost };
    }
  }
  return best;
}
