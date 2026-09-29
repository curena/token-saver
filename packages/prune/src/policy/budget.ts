import type { Config } from "../types.js";

export interface BudgetCandidate {
  id: string;
  messageIndex: number;
  expectedSave: number;
}

export interface BudgetCut {
  ids: string[];
  /** Earliest shortened message index; everything from here is re-processed. -1 when empty. */
  fromIndex: number;
  expectedSave: number;
  reachesTarget: boolean;
}

/** Tokens kept between the emergency level and pi's compaction point. */
export const COMPACTION_MARGIN = 2000;
/** pi's default `compaction.reserveTokens`. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Choose which candidates to shorten so the expected saving covers `need`,
 * re-processing as little as possible. Re-processing covers everything after
 * the earliest shortened result, so take the latest start that is enough; if
 * none is, take everything.
 */
export function planBudgetCut(candidates: BudgetCandidate[], need: number): BudgetCut {
  if (need <= 0) return { ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: true };
  if (candidates.length === 0) return { ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: false };

  const sorted = [...candidates].sort((a, b) => a.messageIndex - b.messageIndex);
  let saved = 0;
  for (let start = sorted.length - 1; start >= 0; start--) {
    saved += sorted[start]!.expectedSave;
    if (saved >= need) {
      const taken = sorted.slice(start);
      return { ids: taken.map((c) => c.id), fromIndex: taken[0]!.messageIndex, expectedSave: saved, reachesTarget: true };
    }
  }
  return { ids: sorted.map((c) => c.id), fromIndex: sorted[0]!.messageIndex, expectedSave: saved, reachesTarget: false };
}

/** pi compacts past `window - reserveTokens`; the emergency sweep must land before that. */
export function emergencyLevel(window: number, reserveTokens: number, contextLevel: number): number {
  return Math.min(contextLevel, (window - reserveTokens - COMPACTION_MARGIN) / window);
}

/** On small windows the emergency cap can fall below highWater; the turn trigger must still come first. */
export function turnLevel(
  window: number,
  reserveTokens: number,
  config: Pick<Config, "highWater" | "contextLevel">,
): number {
  return Math.min(config.highWater, emergencyLevel(window, reserveTokens, config.contextLevel));
}

/**
 * Token count at which a trigger fires again after a sweep that reached `reached`.
 * Reaching lowWater re-arms at the base level. Falling short waits for another
 * (highWater - lowWater) of growth, so a stuck context doesn't sweep, and make the
 * user wait, on every message.
 */
export function nextArmAt(
  reached: number,
  window: number,
  config: Pick<Config, "highWater" | "lowWater">,
  baseTokens: number,
  capTokens: number,
): number {
  if (reached <= config.lowWater * window) return baseTokens;
  const later = reached + (config.highWater - config.lowWater) * window;
  return Math.min(capTokens, Math.max(baseTokens, later));
}
