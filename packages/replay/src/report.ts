import type { Prices } from "@token-saver/core";
import type { ReplayMetrics } from "./run.js";

export interface TauRun {
  tau: number;
  metrics: ReplayMetrics[];
}

export interface Summary {
  tokensBefore: number;
  tokensAfter: number;
  savedPct: number;
  sweeps: number;
  stubbed: number;
  partial: number;
  misses: number;
  jevRequests: number;
  jevUsd: number;
  rewrittenTokens: number;
  sweepMs: number;
  netUsd: number;
  peakBefore: number;
  peakAfter: number;
  meanBefore: number;
  meanAfter: number;
  compactionsBefore: number;
  compactionsAfter: number;
  reprocessedTokens: number;
  skippedSessions: number;
}

export const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

/** Anthropic-shaped defaults, per token. */
export const DEFAULT_PRICES: Prices = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

export function summarize(all: ReplayMetrics[], prices: Prices = DEFAULT_PRICES): Summary {
  const total = all.reduce(
    (sum, metrics) => ({
      tokensBefore: sum.tokensBefore + metrics.tokensBefore,
      tokensAfter: sum.tokensAfter + metrics.tokensAfter,
      sweeps: sum.sweeps + metrics.sweeps,
      stubbed: sum.stubbed + metrics.stubbed,
      partial: sum.partial + metrics.partial,
      misses: sum.misses + metrics.misses.length,
      jevRequests: sum.jevRequests + metrics.jevRequests,
      jevInputTokens: sum.jevInputTokens + metrics.jevInputTokens,
      rewrittenTokens: sum.rewrittenTokens + metrics.rewrittenTokens,
      sweepMs: sum.sweepMs + metrics.sweepMs,
    }),
    {
      tokensBefore: 0, tokensAfter: 0, sweeps: 0, stubbed: 0, partial: 0,
      misses: 0, jevRequests: 0, jevInputTokens: 0, rewrittenTokens: 0, sweepMs: 0,
    },
  );
  const savedPct = total.tokensBefore === 0
    ? 0
    : ((total.tokensBefore - total.tokensAfter) / total.tokensBefore) * 100;

  // Tokens are already summed over every model call, so the saving is cumulative
  // cache reads avoided. Each sweep pays cacheWrite once for the suffix it moved.
  const jevUsd = total.jevInputTokens * JEV_PRICE_PER_TOKEN;
  const netUsd =
    (total.tokensBefore - total.tokensAfter) * prices.cacheRead -
    total.rewrittenTokens * prices.cacheWrite -
    jevUsd;

  const calls = all.reduce((sum, m) => sum + m.calls, 0);
  const peakBefore = Math.max(0, ...all.map((m) => m.peakBefore));
  const peakAfter = Math.max(0, ...all.map((m) => m.peakAfter));
  const meanBefore = calls === 0 ? 0 : all.reduce((s, m) => s + m.contextSumBefore, 0) / calls;
  const meanAfter = calls === 0 ? 0 : all.reduce((s, m) => s + m.contextSumAfter, 0) / calls;
  const compactionsBefore = all.reduce((s, m) => s + m.compactionsBefore, 0);
  const compactionsAfter = all.reduce((s, m) => s + m.compactionsAfter, 0);
  const skippedSessions = all.filter((m) => m.window === null).length;

  return {
    tokensBefore: total.tokensBefore,
    tokensAfter: total.tokensAfter,
    savedPct,
    sweeps: total.sweeps,
    stubbed: total.stubbed,
    partial: total.partial,
    misses: total.misses,
    jevRequests: total.jevRequests,
    jevUsd,
    rewrittenTokens: total.rewrittenTokens,
    sweepMs: total.sweepMs,
    netUsd,
    peakBefore,
    peakAfter,
    meanBefore,
    meanAfter,
    compactionsBefore,
    compactionsAfter,
    reprocessedTokens: total.rewrittenTokens,
    skippedSessions,
  };
}

export function renderReport(runs: TauRun[]): string {
  const round = (n: number): string => Math.round(n).toLocaleString("en-US");
  const lines = [
    "# token-saver replay",
    "",
    "| tau | peak ctx before | peak ctx after | mean ctx before | mean ctx after | sweeps | re-processed | " +
    "compactions before | compactions after | misses | jev reqs | jev $ | net $ | tokens before | tokens after | saved | stubbed | partial |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  // Every tau replays the same sessions, so the skipped count is the same for
  // each run; summing across taus would multiply-count the same sessions.
  let skippedSessions = 0;
  for (const run of runs) {
    const s = summarize(run.metrics);
    skippedSessions = s.skippedSessions;
    lines.push(
      `| ${run.tau} | ${round(s.peakBefore)} | ${round(s.peakAfter)} | ` +
      `${round(s.meanBefore)} | ${round(s.meanAfter)} | ${s.sweeps} | ${round(s.reprocessedTokens)} | ` +
      `${s.compactionsBefore} | ${s.compactionsAfter} | ${s.misses} | ${s.jevRequests} | ${s.jevUsd.toFixed(4)} | ` +
      `${s.netUsd.toFixed(4)} | ${round(s.tokensBefore)} | ${round(s.tokensAfter)} | ${s.savedPct.toFixed(1)}% | ` +
      `${s.stubbed} | ${s.partial} |`,
    );
  }
  lines.push(
    "",
    "Context (ctx) is each call's recorded provider prompt size (input + cache read + cache write), " +
    "minus savings; a chars/4 estimate where no usage was recorded.",
  );
  lines.push("", "A miss is an elided chunk whose text the agent later used: it would have cost a recall.");
  lines.push(
    "",
    "Re-processed is the tokens prompt-processed again after sweeps: the waiting cost. Net $ is secondary.",
  );
  if (skippedSessions > 0) {
    lines.push("", `${skippedSessions} session(s) skipped: unknown context window (pass --window).`);
  }
  return lines.join("\n");
}
