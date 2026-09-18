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
  };
}

export function renderReport(runs: TauRun[]): string {
  const lines = [
    "# token-saver replay",
    "",
    "| tau | tokens before | tokens after | saved | sweeps | stubbed | partial | misses | jev reqs | jev $ | net $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of runs) {
    const s = summarize(run.metrics);
    lines.push(
      `| ${run.tau} | ${s.tokensBefore.toLocaleString("en-US")} | ${s.tokensAfter.toLocaleString("en-US")} | ` +
      `${s.savedPct.toFixed(1)}% | ${s.sweeps} | ${s.stubbed} | ${s.partial} | ${s.misses} | ` +
      `${s.jevRequests} | ${s.jevUsd.toFixed(4)} | ${s.netUsd.toFixed(4)} |`,
    );
  }
  lines.push("", "A miss is an elided chunk whose text the agent later used: it would have cost a recall.");
  lines.push("", "Net $ is cache reads avoided minus cache writes paid minus Jev spend, at Anthropic prices.");
  return lines.join("\n");
}
