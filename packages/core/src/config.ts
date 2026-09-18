import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  minResultTokens: 1500,
  protectTurns: 2,
  keepThreshold: 0.3,
  leaveAloneRatio: 0.7,
  minSaving: 500,
  costMargin: 1.5,
  contextLevel: 0.6,
  expectedSaveRatio: 0.5,
  jevBudgetMs: 1500,
  jevModel: "jev-1.13.0",
  excludedTools: ["edit", "write"],
};
