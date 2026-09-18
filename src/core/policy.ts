import type { FitLevel, InventoryItem, Proposal } from "./types.js";

export const RECENT_USE_DAYS = 30;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Decide the state to propose for one item.
 * Never proposes "off": that would hide the skill from the user's own / menu too.
 */
export function proposeState(
  item: InventoryItem,
  fit: FitLevel | null,
  uses: number,
): Proposal {
  const base = {
    id: item.id,
    name: item.name,
    from: item.currentState,
    fit,
    uses,
    tokens: item.tokens,
  };
  if (!item.managed) {
    return { ...base, to: item.currentState, reason: "not settable per project" };
  }
  if (uses > 0) {
    return { ...base, to: "on", reason: `used ${uses}x in the last ${RECENT_USE_DAYS} days` };
  }
  if (fit === null) {
    return { ...base, to: item.currentState, reason: "no judgment available" };
  }
  if (fit === 1) return { ...base, to: "on", reason: "core to this project" };
  if (fit === 2 || fit === 3) {
    return { ...base, to: "name-only", reason: "occasionally useful; name kept in context" };
  }
  return { ...base, to: "user-invocable-only", reason: "irrelevant here and unused" };
}
