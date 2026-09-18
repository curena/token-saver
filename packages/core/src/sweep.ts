import { chunkResult } from "./chunk.js";
import { estimateTokens } from "./tokens.js";
import { buildRequest, judgeResult } from "./judge.js";
import type { JevClient, TaskState } from "./judge.js";
import { decideLevel } from "./policy/decide.js";
import { selectEligible } from "./policy/eligibility.js";
import { findSuperseded } from "./policy/staleness.js";
import type { FileTouch } from "./policy/staleness.js";
import { planCostGate } from "./policy/cost.js";
import { renderPartial, renderStub } from "./render.js";
import type { Config, Decision, Prices, ResultRef } from "./types.js";

export interface SweepInput {
  results: ResultRef[];
  decided: ReadonlyMap<string, Decision>;
  touches: FileTouch[];
  task: TaskState;
  afterResultFor: (result: ResultRef) => string;
  tokensAfter: (messageIndex: number) => number;
  callsSoFar: number;
  prices: Prices | null;
  config: Config;
  client: JevClient;
  currentTurn: number;
  trigger: "cost" | "context";
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
  reason: "swept" | "no-candidates" | "gate" | "post-gate" | "judge-failed";
}

function empty(reason: SweepOutcome["reason"], jevRequests = 0, jevInputTokens = 0): SweepOutcome {
  return { decisions: [], savedTokens: 0, jevRequests, jevInputTokens, probabilitiesById: {}, reason };
}

function firstLineOf(result: ResultRef): number {
  const offset = result.input.offset;
  return typeof offset === "number" && offset > 0 ? offset : 1;
}

export async function runSweep(input: SweepInput): Promise<SweepOutcome> {
  const { config, trigger } = input;
  let eligible = selectEligible(input.results, input.decided, config, {
    minTurnsAgo: trigger === "context" ? 1 : config.protectTurns,
  });
  if (eligible.length === 0) return empty("no-candidates");

  const superseded = findSuperseded(eligible, input.touches);

  if (trigger === "cost") {
    const gate = planCostGate({
      candidates: eligible.map((result) => ({
        id: result.id,
        messageIndex: result.messageIndex,
        expectedSave: superseded.has(result.id)
          ? result.tokens
          : Math.round(result.tokens * config.expectedSaveRatio),
      })),
      tokensAfter: input.tokensAfter,
      callsSoFar: input.callsSoFar,
      prices: input.prices,
      costMargin: config.costMargin,
    });
    if (!gate.sweep) return empty("gate");
    const allowed = new Set(gate.ids);
    eligible = eligible.filter((result) => allowed.has(result.id));
  }

  const decisions: Decision[] = [];
  const probabilitiesById: Record<string, number[]> = {};
  let jevRequests = 0;
  let jevInputTokens = 0;

  for (const result of eligible) {
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
    if (probabilities === null) return empty("judge-failed", jevRequests, jevInputTokens);
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

  const savedTokens = decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
  if (decisions.length === 0) return empty("post-gate", jevRequests, jevInputTokens);

  if (trigger === "cost") {
    const postGate = planCostGate({
      candidates: decisions.map((decision) => ({
        id: decision.id,
        messageIndex: input.results.find((r) => r.id === decision.id)!.messageIndex,
        expectedSave: decision.savedTokens,
      })),
      tokensAfter: input.tokensAfter,
      callsSoFar: input.callsSoFar,
      prices: input.prices,
      costMargin: config.costMargin,
    });
    if (!postGate.sweep) return empty("post-gate", jevRequests, jevInputTokens);
  }

  return { decisions, savedTokens, jevRequests, jevInputTokens, probabilitiesById, reason: "swept" };
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
