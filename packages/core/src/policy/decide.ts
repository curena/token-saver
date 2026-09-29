import type { Chunk, Config, Level } from "../types.js";

export interface LevelPlan {
  level: Level;
  keptChunks: number[];
  savedTokens: number;
}

const LEAVE: LevelPlan = { level: "leave", keptChunks: [], savedTokens: 0 };

/**
 * A probability that is missing, or not a real number in 0..1, counts as keep.
 * judgeResult already substitutes 1 for both, so this should be unreachable
 * through that path; the replay CLI calls decideLevel directly, and if the two
 * layers ever disagree both must err towards leaving context intact.
 */
function keepScore(probability: number | undefined): number {
  return typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? probability
    : 1;
}

export function decideLevel(
  chunks: Chunk[],
  probabilities: number[],
  config: Config,
  overheadTokens = 40,
): LevelPlan {
  const total = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  if (total === 0) return LEAVE;

  const kept = chunks.filter((chunk) => keepScore(probabilities[chunk.index]) >= config.keepThreshold);
  const keptTokens = kept.reduce((sum, chunk) => sum + chunk.tokens, 0);

  if (keptTokens >= total * config.leaveAloneRatio) return LEAVE;

  const savedTokens = total - keptTokens - overheadTokens;
  if (savedTokens < config.minSaving) return LEAVE;

  return {
    level: kept.length === 0 ? "stub" : "partial",
    keptChunks: kept.map((chunk) => chunk.index),
    savedTokens,
  };
}
