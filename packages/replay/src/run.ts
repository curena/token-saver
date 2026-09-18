import { applyDecisions, chunkResult, runSweep } from "@token-saver/core";
import type { Config, Decision, JevClient, Prices } from "@token-saver/core";
import { afterResultSummary, parseSession } from "./session.js";
import { collectLaterUses, detectMisses } from "./retention.js";
import type { Miss } from "./retention.js";

export interface ReplayMetrics {
  session: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  sweeps: number;
  stubbed: number;
  partial: number;
  jevRequests: number;
  jevInputTokens: number;
  /** Tokens re-written to cache because a sweep changed the history before them. */
  rewrittenTokens: number;
  sweepMs: number;
  misses: Miss[];
}

export async function replaySession(
  jsonl: string,
  name: string,
  client: JevClient,
  config: Config,
  prices: Prices | null,
): Promise<ReplayMetrics> {
  const sites = parseSession(jsonl);
  const decided = new Map<string, Decision>();
  const metrics: ReplayMetrics = {
    session: name, calls: sites.length, tokensBefore: 0, tokensAfter: 0,
    sweeps: 0, stubbed: 0, partial: 0, jevRequests: 0, jevInputTokens: 0,
    rewrittenTokens: 0, sweepMs: 0, misses: [],
  };

  for (const [callIndex, site] of sites.entries()) {
    const before = site.results.reduce((sum, result) => sum + result.tokens, 0);
    metrics.tokensBefore += before;

    if (config.enabled) {
      const startedAt = Date.now();
      const outcome = await runSweep({
        results: site.results,
        decided,
        touches: site.touches,
        task: {
          recent_user_messages: site.recentUserMessages.slice(-2),
          latest_assistant_text: site.latestAssistantText,
          working_files: site.workingFiles,
        },
        afterResultFor: (result) => afterResultSummary(site, result),
        tokensAfter: (messageIndex) =>
          site.results
            .filter((result) => result.messageIndex >= messageIndex)
            .reduce((sum, result) => sum + result.tokens, 0),
        callsSoFar: callIndex + 1,
        prices,
        config,
        client,
        currentTurn: site.userTurn,
        trigger: "cost",
      });
      metrics.sweepMs += Date.now() - startedAt;
      metrics.jevRequests += outcome.jevRequests;
      metrics.jevInputTokens += outcome.jevInputTokens;

      if (outcome.decisions.length > 0) {
        metrics.sweeps++;
        const fromIndex = Math.min(
          ...outcome.decisions.map(
            (decision) => site.results.find((result) => result.id === decision.id)!.messageIndex,
          ),
        );
        metrics.rewrittenTokens += site.results
          .filter((result) => result.messageIndex >= fromIndex)
          .reduce((sum, result) => sum + result.tokens, 0);

        for (const decision of outcome.decisions) {
          decided.set(decision.id, decision);
          if (decision.level === "stub") metrics.stubbed++;
          if (decision.level === "partial") metrics.partial++;

          const result = site.results.find((candidate) => candidate.id === decision.id)!;
          const chunks = chunkResult(result.toolName, result.text);
          const elided = chunks
            .map((chunk) => chunk.index)
            .filter((index) => !decision.keptChunks.includes(index));
          metrics.misses.push(
            ...detectMisses(
              decision.id,
              chunks,
              outcome.probabilitiesById[decision.id] ?? [],
              elided,
              collectLaterUses(jsonl, result.messageIndex),
            ),
          );
        }
      }
    }

    const applied = applyDecisions(
      site.results.map((result) => ({ id: result.id, text: result.text, tokens: result.tokens })),
      decided,
    );
    metrics.tokensAfter += applied.reduce(
      (sum, message) => sum + Math.ceil(message.text.length / 4),
      0,
    );
  }

  return metrics;
}