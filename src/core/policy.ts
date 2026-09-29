import type { FitLevel, InventoryItem, Proposal, SkillState } from "./types.js";

export const RECENT_USE_DAYS = 30;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * How much of a skill each state leaves in the session prompt, most visible first.
 *
 * The audit only ever moves a skill *down* this ladder. Restricting something the user
 * left alone is the whole point of the tool; un-restricting something they deliberately
 * hid is not a saving, it is this tool overwriting a decision that was not its to make.
 * That cuts against both a good fit and recent use -- a skill someone set to
 * `user-invocable-only` and still reaches for by name is a skill the arrangement is
 * working for.
 */
const VISIBILITY: Record<SkillState, number> = {
  on: 3,
  "name-only": 2,
  "user-invocable-only": 1,
  off: 0,
};

/**
 * What one item costs in every session's prompt at a given state: `on` injects the name
 * and the whole description, `name-only` keeps just the name so the model knows to ask,
 * and the two hidden states cost nothing until the user types the name themselves.
 */
function stateCost(item: InventoryItem, state: SkillState): number {
  if (state === "on") return item.tokens;
  if (state === "name-only") return estimateTokens(item.name);
  return 0;
}

/**
 * The state this item would ideally be in, before any consideration of where it is now.
 * Never returns "off": that would hide the skill from the user's own / menu too.
 */
function desiredState(
  item: InventoryItem,
  fit: FitLevel | null,
  uses: number,
): { to: SkillState; reason: string } {
  if (!item.managed) {
    return { to: item.currentState, reason: "not settable per project" };
  }
  if (uses > 0) {
    return { to: "on", reason: `used ${uses}x in the last ${RECENT_USE_DAYS} days` };
  }
  if (fit === null) {
    return { to: item.currentState, reason: "no judgment available" };
  }
  if (fit === 1) return { to: "on", reason: "core to this project" };
  if (fit === 2 || fit === 3) {
    return { to: "name-only", reason: "occasionally useful; name kept in context" };
  }
  return { to: "user-invocable-only", reason: "irrelevant here and unused" };
}

/**
 * Decide the state to propose for one item, and what proposing it would save.
 *
 * `tokens` is the saving, not the item's cost -- the two coincide only for an item that
 * starts fully `on` and ends up fully hidden. Because the proposal can never be more
 * visible than the current state, the saving is never negative.
 */
export function proposeState(
  item: InventoryItem,
  fit: FitLevel | null,
  uses: number,
): Proposal {
  const { to: desired, reason } = desiredState(item, fit, uses);
  const to = VISIBILITY[desired] > VISIBILITY[item.currentState] ? item.currentState : desired;
  return {
    id: item.id,
    name: item.name,
    from: item.currentState,
    to,
    fit,
    uses,
    tokens: stateCost(item, item.currentState) - stateCost(item, to),
    reason,
  };
}
