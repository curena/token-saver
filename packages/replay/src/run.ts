import {
  applyDecisions, chunkResult, emergencyLevel, firstLineOf, nextArmAt, runSweep, turnLevel,
} from "@token-saver/core";
import type { Config, Decision, JevClient } from "@token-saver/core";
import { afterResultSummary, parseSession } from "./session.js";
import type { CallSite } from "./session.js";
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
  /** Tokens re-processed because a sweep changed history before them (the waiting cost). */
  rewrittenTokens: number;
  sweepMs: number;
  misses: Miss[];
  /** The session's context window, or null when it could not be determined (sweeps are skipped). */
  window: number | null;
  /** Largest context at any call, without / with token-saver. The context is the
   * call's recorded provider usage (input + cacheRead + cacheWrite), or the
   * chars/4 message estimate when none was recorded; "with" subtracts savings. */
  peakBefore: number;
  peakAfter: number;
  /** Sum of simulated context over all calls; divide by calls for the mean. */
  contextSumBefore: number;
  contextSumAfter: number;
  /** Times the context crossed pi's compaction point (window - reserve), without / with. */
  compactionsBefore: number;
  compactionsAfter: number;
}

export interface ReplayOptions {
  window: number | null;
  reserveTokens: number;
}

/**
 * T_after (spec §6.1): every message's tokens from `fromIndex` to the end of the
 * context, as re-processed after the sweep — shortened results count at their
 * post-sweep (stub/partial) size.
 */
function suffixTokens(site: CallSite, fromIndex: number, decided: ReadonlyMap<string, Decision>): number {
  let sum = 0;
  for (let index = fromIndex; index < site.tokenCounts.length; index++) sum += site.tokenCounts[index] ?? 0;
  for (const result of site.results) {
    if (result.messageIndex >= fromIndex) sum -= decided.get(result.id)?.savedTokens ?? 0;
  }
  return sum;
}

/**
 * The context size pi saw at this call: the provider's recorded prompt size,
 * which includes the system prompt, tool schemas and thinking that the message
 * estimate misses. Falls back to the estimate when no usage was recorded.
 */
function recordedContext(site: CallSite): number {
  const { input, cacheRead, cacheWrite } = site.usage;
  const recorded = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (recorded > 0) return recorded;
  return site.tokenCounts.reduce((sum, tokens) => sum + (tokens ?? 0), 0);
}

export async function replaySession(
  jsonl: string,
  name: string,
  client: JevClient,
  config: Config,
  options: ReplayOptions,
): Promise<ReplayMetrics> {
  const sites = parseSession(jsonl);
  const decided = new Map<string, Decision>();
  const metrics: ReplayMetrics = {
    session: name, calls: sites.length, tokensBefore: 0, tokensAfter: 0,
    sweeps: 0, stubbed: 0, partial: 0, jevRequests: 0, jevInputTokens: 0,
    rewrittenTokens: 0, sweepMs: 0, misses: [],
    window: options.window,
    peakBefore: 0, peakAfter: 0, contextSumBefore: 0, contextSumAfter: 0,
    compactionsBefore: 0, compactionsAfter: 0,
  };

  // Arm points for the next sweep; null means "use the config-derived base level".
  // Capped at the emergency base/compaction point respectively, matching the pi
  // adapter: a trigger that falls short must not be able to re-arm past the
  // point the next trigger up would fire anyway.
  let turnArmAt: number | null = null;
  let emergencyArmAt: number | null = null;
  let wasOverBefore = false;
  let wasOverAfter = false;

  for (const site of sites) {
    const before = site.results.reduce((sum, result) => sum + result.tokens, 0);
    metrics.tokensBefore += before;

    const contextBefore = recordedContext(site);
    const savedSoFar = site.results.reduce((sum, result) => sum + (decided.get(result.id)?.savedTokens ?? 0), 0);
    let contextAfter = contextBefore - savedSoFar;

    const window = options.window;
    if (config.enabled && window !== null) {
      // The simulated context (after token-saver) has shrunk back to (or below)
      // the sweep target — most likely a compaction happened — so arm points
      // raised before that no longer apply. Checked before the trigger decision.
      if (contextAfter <= config.lowWater * window) {
        turnArmAt = null;
        emergencyArmAt = null;
      }

      const turnBase = turnLevel(window, options.reserveTokens, config) * window;
      const emergencyBase = emergencyLevel(window, options.reserveTokens, config.contextLevel) * window;
      const compactionPoint = window - options.reserveTokens;
      const trigger: "turn" | "context" | null =
        contextAfter >= (emergencyArmAt ?? emergencyBase) ? "context"
        : site.atTurnStart && contextAfter >= (turnArmAt ?? turnBase) ? "turn"
        : null;

      if (trigger !== null) {
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
          currentTokens: contextAfter,
          targetTokens: config.lowWater * window,
          config,
          client,
          currentTurn: site.userTurn,
          trigger,
        });
        metrics.sweepMs += Date.now() - startedAt;
        metrics.jevRequests += outcome.jevRequests;
        metrics.jevInputTokens += outcome.jevInputTokens;
        // Capped at the emergency base / compaction point, not Infinity: see the
        // note on turnArmAt/emergencyArmAt above.
        turnArmAt = nextArmAt(outcome.reached, window, config, turnBase, emergencyBase);
        // Spec §2.1: the emergency trigger re-arms only after it fires itself.
        if (trigger === "context") {
          emergencyArmAt = nextArmAt(outcome.reached, window, config, emergencyBase, compactionPoint);
        }
        contextAfter = outcome.reached;

        if (outcome.decisions.length > 0) {
          metrics.sweeps++;
          for (const decision of outcome.decisions) decided.set(decision.id, decision);
          metrics.rewrittenTokens += suffixTokens(site, outcome.fromIndex, decided);

          for (const decision of outcome.decisions) {
            if (decision.level === "stub") metrics.stubbed++;
            if (decision.level === "partial") metrics.partial++;

            const result = site.results.find((candidate) => candidate.id === decision.id)!;
            const chunks = chunkResult(result.toolName, result.text, firstLineOf(result));
            const elided = chunks
              .map((chunk) => chunk.index)
              .filter((index) => !decision.keptChunks.includes(index));
            metrics.misses.push(
              ...detectMisses(
                decision.id,
                chunks,
                outcome.probabilitiesById[decision.id] ?? [],
                elided,
                // Uses before this call saw the result in full; only the call
                // being made now and later ones worked from the cut version.
                collectLaterUses(jsonl, site.entryIndex - 1),
              ),
            );
          }
        }
      }
    }

    metrics.peakBefore = Math.max(metrics.peakBefore, contextBefore);
    metrics.peakAfter = Math.max(metrics.peakAfter, contextAfter);
    metrics.contextSumBefore += contextBefore;
    metrics.contextSumAfter += contextAfter;
    if (options.window !== null) {
      const point = options.window - options.reserveTokens;
      const overBefore = contextBefore > point;
      const overAfter = contextAfter > point;
      if (overBefore && !wasOverBefore) metrics.compactionsBefore++;
      if (overAfter && !wasOverAfter) metrics.compactionsAfter++;
      wasOverBefore = overBefore;
      wasOverAfter = overAfter;
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
