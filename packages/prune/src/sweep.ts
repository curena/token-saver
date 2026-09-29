import { chunkResult } from "./chunk.js";
import { estimateTokens } from "@token-saver/core";
import { buildRequest, judgeResult } from "./judge.js";
import type { JevClient, TaskState } from "./judge.js";
import { decideLevel } from "./policy/decide.js";
import { selectEligible } from "./policy/eligibility.js";
import { findSuperseded } from "./policy/staleness.js";
import type { FileTouch } from "./policy/staleness.js";
import { planBudgetCut } from "./policy/budget.js";
import { renderPartial, renderStub } from "./render.js";
import type { Config, Decision, ResultRef } from "./types.js";

export interface SweepInput {
  results: ResultRef[];
  decided: ReadonlyMap<string, Decision>;
  touches: FileTouch[];
  task: TaskState;
  afterResultFor: (result: ResultRef) => string;
  /** Context tokens now. */
  currentTokens: number;
  /** Context tokens to get down to. */
  targetTokens: number;
  config: Config;
  client: JevClient;
  currentTurn: number;
  trigger: "turn" | "context";
  signal?: AbortSignal;
}

export interface SweepOutcome {
  decisions: Decision[];
  savedTokens: number;
  jevRequests: number;
  /** Estimated Jev input tokens, for spend reporting. */
  jevInputTokens: number;
  /** Chunk probabilities per judged result, for the replay retention report. */
  probabilitiesById: Record<string, number[]>;
  reason: "swept" | "at-target" | "no-candidates" | "nothing-shortened" | "judge-failed";
  /** Earliest shortened message index; everything after it is re-processed. -1 if none. */
  fromIndex: number;
  /** Context tokens after the sweep: currentTokens - savedTokens. */
  reached: number;
}

export function firstLineOf(result: ResultRef): number {
  const offset = result.input.offset;
  return typeof offset === "number" && offset > 0 ? offset : 1;
}

export async function runSweep(input: SweepInput): Promise<SweepOutcome> {
  const { config, trigger } = input;
  const finish = (
    decisions: Decision[],
    reason: SweepOutcome["reason"],
    jevRequests = 0,
    jevInputTokens = 0,
    probabilitiesById: Record<string, number[]> = {},
  ): SweepOutcome => {
    const savedTokens = decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
    const indexes = decisions.map((d) => input.results.find((r) => r.id === d.id)!.messageIndex);
    return {
      decisions, savedTokens, jevRequests, jevInputTokens, probabilitiesById, reason,
      fromIndex: indexes.length > 0 ? Math.min(...indexes) : -1,
      reached: input.currentTokens - savedTokens,
    };
  };

  const need = input.currentTokens - input.targetTokens;
  if (need <= 0) return finish([], "at-target");

  const eligible = selectEligible(input.results, input.decided, config, {
    minTurnsAgo: trigger === "context" ? 1 : config.protectTurns,
  });
  if (eligible.length === 0) return finish([], "no-candidates");

  const superseded = findSuperseded(eligible, input.touches);
  const cut = planBudgetCut(
    eligible.map((result) => ({
      id: result.id,
      messageIndex: result.messageIndex,
      expectedSave: superseded.has(result.id)
        ? result.tokens
        : Math.round(result.tokens * config.expectedSaveRatio),
    })),
    need,
  );
  const chosen = new Set(cut.ids);
  // Superseded stubs first: they need no Jev call, so they survive a Jev failure.
  const ordered = eligible
    .filter((result) => chosen.has(result.id))
    .sort((a, b) => Number(superseded.has(b.id)) - Number(superseded.has(a.id)));

  const decisions: Decision[] = [];
  const probabilitiesById: Record<string, number[]> = {};
  let jevRequests = 0;
  let jevInputTokens = 0;

  for (const result of ordered) {
    const chunks = chunkResult(result.toolName, result.text, firstLineOf(result));
    const lineCount = result.text.split("\n").length;

    if (superseded.has(result.id)) {
      decisions.push({
        id: result.id, level: "stub", rendered: renderStub(result, lineCount),
        savedTokens: result.tokens, reason: "superseded", keptChunks: [],
        decidedAtTurn: input.currentTurn,
      });
      continue;
    }

    const request = buildRequest(result, chunks, input.task, input.afterResultFor(result), config);
    const probabilities = await judgeResult(input.client, request, chunks.length, config, input.signal);
    jevRequests++;
    jevInputTokens += estimateTokens(JSON.stringify(request));
    if (probabilities === null) {
      return finish(decisions, "judge-failed", jevRequests, jevInputTokens, probabilitiesById);
    }
    probabilitiesById[result.id] = probabilities;

    const plan = decideLevel(chunks, probabilities, config);
    if (plan.level === "leave") continue;
    decisions.push({
      id: result.id,
      level: plan.level,
      rendered: plan.level === "stub"
        ? renderStub(result, lineCount)
        : renderPartial(result, chunks, plan.keptChunks),
      savedTokens: plan.savedTokens,
      reason: "judged",
      keptChunks: plan.keptChunks,
      decidedAtTurn: input.currentTurn,
    });
  }

  return finish(
    decisions,
    decisions.length > 0 ? "swept" : "nothing-shortened",
    jevRequests, jevInputTokens, probabilitiesById,
  );
}

export function applyDecisions<M extends { id: string; text: string }>(
  results: M[],
  decided: ReadonlyMap<string, Decision>,
): M[] {
  return results.map((message) => {
    const decision = decided.get(message.id);
    if (decision === undefined || decision.rendered === null) return message;
    return { ...message, text: decision.rendered };
  });
}
