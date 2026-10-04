import { isDenylistedPath } from "@token-saver/core";
import type { Config, Decision, ResultRef } from "../types.js";

/**
 * True when a tool call's input mentions a path on the secrets denylist (`.env*`, `*.pem`,
 * `id_*`, `secrets/**`).
 *
 * The audit can simply not open a denylisted file. The pruner never opens anything -- the
 * text is already in the context by the time it sees it -- so the equivalent move is to
 * leave the result alone: unjudged, unsent, and unpruned. That costs the saving and keeps
 * the content off the wire, which is the right way round. Redaction is still the backstop,
 * but a `.env` file is secrets end to end and a heuristic pass over it is not a guarantee.
 *
 * Every string in the input is split on whitespace and each word tested, because the path
 * is rarely the whole value: `{ command: "cat .env" }` has to match, and the denylist
 * patterns anchor on a path boundary rather than scanning loosely. The false positives this
 * admits (a word like `.environment` in prose) cost one missed saving and nothing else.
 */
function touchesDenylistedPath(value: unknown, depth = 0): boolean {
  if (typeof value === "string") {
    return value.split(/\s+/).some((word) => isDenylistedPath(word));
  }
  // A tool input is JSON from the harness, so it is shallow in practice; the bound is here
  // so a pathological one cannot turn an eligibility check into a deep walk.
  if (depth >= 4) return false;
  if (Array.isArray(value)) return value.some((item) => touchesDenylistedPath(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => touchesDenylistedPath(item, depth + 1));
  }
  return false;
}

export function selectEligible(
  results: ResultRef[],
  decided: ReadonlyMap<string, Decision>,
  config: Config,
  options: { minTurnsAgo?: number } = {},
): ResultRef[] {
  const minTurnsAgo = options.minTurnsAgo ?? config.protectTurns;
  return results.filter((result) => {
    if (decided.has(result.id)) return false;
    if (result.isError) return false;
    if (result.tokens < config.minResultTokens) return false;
    if (config.excludedTools.includes(result.toolName)) return false;
    if (touchesDenylistedPath(result.input)) return false;
    // Recall output is protected by the same window: recalling then immediately
    // re-stubbing would strand the agent.
    return result.turnsAgo > minTurnsAgo;
  });
}
