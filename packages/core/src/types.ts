/** One tool result as it appears in the model context. */
export interface ResultRef {
  /** The originating tool call's id; also the recall handle. */
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Full result text, all text blocks joined with "\n". */
  text: string;
  tokens: number;
  /** Index in the context message array. */
  messageIndex: number;
  /** Completed user turns since this result. 0 = current turn. */
  turnsAgo: number;
  isError: boolean;
}

export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
}

export type Level = "stub" | "partial" | "leave";

export interface Decision {
  id: string;
  level: Level;
  /** Replacement text; null when level is "leave". */
  rendered: string | null;
  savedTokens: number;
  reason: "superseded" | "judged";
  /** Chunk indices kept verbatim; empty for "stub" and "leave". */
  keptChunks: number[];
  decidedAtTurn: number;
}

export interface SweepEntryData {
  decisions: Decision[];
  trigger: "cost" | "context";
  at: string;
}

/** Per-token prices. null prices mean the provider has no prompt caching. */
export interface Prices {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Config {
  enabled: boolean;
  minResultTokens: number;
  protectTurns: number;
  keepThreshold: number;
  leaveAloneRatio: number;
  minSaving: number;
  costMargin: number;
  contextLevel: number;
  expectedSaveRatio: number;
  jevBudgetMs: number;
  jevModel: string;
  excludedTools: string[];
}
