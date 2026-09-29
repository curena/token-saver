import type { Config, Decision, ResultRef } from "../types.js";

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
    // Recall output is protected by the same window: recalling then immediately
    // re-stubbing would strand the agent.
    return result.turnsAgo > minTurnsAgo;
  });
}
