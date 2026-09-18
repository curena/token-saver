import type { Chunk, Config, Level } from "../types.js";

export interface LevelPlan {
  level: Level;
  keptChunks: number[];
  savedTokens: number;
}

const LEAVE: LevelPlan = { level: "leave", keptChunks: [], savedTokens: 0 };

export function decideLevel(
  chunks: Chunk[],
  probabilities: number[],
  config: Config,
  overheadTokens = 40,
): LevelPlan {
  const total = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  if (total === 0) return LEAVE;

  // A chunk with no probability is kept, never dropped. judgeResult already
  // fills a missing answer with 1, so this branch should be unreachable; if the
  // two layers ever disagree, both must err towards leaving context intact.
  const kept = chunks.filter((chunk) => (probabilities[chunk.index] ?? 1) >= config.keepThreshold);
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
