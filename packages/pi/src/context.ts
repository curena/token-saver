import { estimateTokens, findSuperseded, runSweep, selectEligible } from "@token-saver/core";
import type {
  Config, FileTouch, JevClient, Prices, ResultRef, SweepOutcome, TaskState,
} from "@token-saver/core";
import type { DecisionStore } from "./state.js";

export interface PiMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface HandleInput {
  messages: PiMessage[];
  store: DecisionStore;
  config: Config;
  client: JevClient | null;
  prices: Prices | null;
  contextFraction: number | null;
  callsSoFar: number;
  lastForcedFraction: number | null;
  lastForcedEligible: number | null;
  cooldownUntilTurn: number;
  signal?: AbortSignal;
}

export interface HandleOutput {
  messages: PiMessage[] | null;
  sweep: SweepOutcome | null;
  trigger: "cost" | "context" | null;
  cooldownUntilTurn: number;
  lastForcedFraction: number | null;
  lastForcedEligible: number | null;
}

const TOUCH_KIND: Record<string, FileTouch["kind"]> = { read: "read", edit: "edit", write: "write" };
const FORCE_STEP = 0.1;
const COOLDOWN_TURNS = 3;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Tokens a message contributes to a rewritten suffix: its text plus any
 * assistant tool-call arguments (write payloads, edit strings), which the
 * provider re-sends just like text.
 */
function messageTokens(content: unknown): number {
  let tokens = estimateTokens(textOf(content));
  if (!Array.isArray(content)) return tokens;
  for (const block of content) {
    const call = block as { type?: string; name?: string; arguments?: unknown };
    if (call.type !== "toolCall") continue;
    tokens += estimateTokens(`${call.name ?? ""}${JSON.stringify(call.arguments ?? {})}`);
  }
  return tokens;
}

function lineArg(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Results Jev judged and left alone, with the user turn they were judged in.
 * Within one agent run the user turn does not advance, so the cost trigger
 * would otherwise re-send the same large "leave" results to Jev on every model
 * call. They are skipped until the next user message: the task Jev judges
 * against is the recent user messages, so a new one is what can change the
 * verdict. Keyed by store so each session's store carries its own memory
 * without the caller threading more state.
 */
const leftAloneByStore = new WeakMap<DecisionStore, Map<string, number>>();

function leftAloneFor(store: DecisionStore): Map<string, number> {
  let map = leftAloneByStore.get(store);
  if (map === undefined) {
    map = new Map();
    leftAloneByStore.set(store, map);
  }
  return map;
}

function pathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function collectResults(messages: PiMessage[]): {
  results: ResultRef[];
  touches: FileTouch[];
  task: TaskState;
  currentTurn: number;
} {
  const results: ResultRef[] = [];
  const resultTurns: number[] = [];
  const touches: FileTouch[] = [];
  const userMessages: string[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  const touchByCall = new Map<string, FileTouch>();
  let currentTurn = 0;
  let latestAssistantText = "";

  messages.forEach((message, messageIndex) => {
    if (message.role === "user") {
      currentTurn++;
      userMessages.push(textOf(message.content));
      return;
    }
    if (message.role === "assistant") {
      latestAssistantText = textOf(message.content) || latestAssistantText;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
        if (call.type !== "toolCall" || call.id === undefined || call.name === undefined) continue;
        const args = call.arguments ?? {};
        calls.set(call.id, { name: call.name, args, turn: currentTurn });
        const kind = TOUCH_KIND[call.name];
        const path = pathArg(args);
        if (kind === undefined || path === null) continue;
        const touch: FileTouch = { path, messageIndex, kind };
        if (kind === "read") {
          const offset = lineArg(args.offset);
          const limit = lineArg(args.limit);
          if (offset !== undefined) touch.offset = offset;
          if (limit !== undefined) touch.limit = limit;
        }
        touches.push(touch);
        touchByCall.set(call.id, touch);
      }
      return;
    }
    if (message.role !== "toolResult") return;

    const id = message.toolCallId ?? `unknown_${messageIndex}`;
    const call = calls.get(id);
    const touch = touchByCall.get(id);
    if (touch !== undefined) touch.isError = message.isError === true;
    const text = textOf(message.content);
    results.push({
      id,
      toolName: message.toolName ?? call?.name ?? "unknown",
      input: call?.args ?? {},
      text,
      tokens: estimateTokens(text),
      messageIndex,
      turnsAgo: 0, // filled in below, against the final turn count
      isError: message.isError === true,
    });
    resultTurns.push(call?.turn ?? currentTurn);
  });

  return {
    // turnsAgo is measured from the latest turn, not from the turn the result
    // arrived in — mid-walk it would always be zero.
    results: results.map((result, i) => ({ ...result, turnsAgo: currentTurn - resultTurns[i]! })),
    touches,
    currentTurn,
    task: {
      recent_user_messages: userMessages.slice(-2),
      latest_assistant_text: latestAssistantText,
      // A failed edit or write changed nothing on disk.
      working_files: [...new Set(
        touches.filter((t) => t.kind !== "read" && t.isError !== true).map((t) => t.path),
      )],
    },
  };
}

function withDecisions(messages: PiMessage[], store: DecisionStore): PiMessage[] | null {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "toolResult" || message.toolCallId === undefined) return message;
    const decision = store.get().get(message.toolCallId);
    if (decision === undefined || decision.rendered === null) return message;
    changed = true;
    return { ...message, content: [{ type: "text", text: decision.rendered }] };
  });
  return changed ? out : null;
}

export async function handleContext(input: HandleInput): Promise<HandleOutput> {
  const unchanged: HandleOutput = {
    messages: null, sweep: null, trigger: null,
    cooldownUntilTurn: input.cooldownUntilTurn,
    lastForcedFraction: input.lastForcedFraction,
    lastForcedEligible: input.lastForcedEligible,
  };
  if (!input.config.enabled || input.client === null) {
    // Decisions are immutable: "/token-saver off" stops sweeps but existing
    // stubs stay applied (spec §7); only the sweep is gated on `enabled`.
    return { ...unchanged, messages: withDecisions(input.messages, input.store) };
  }

  const collected = collectResults(input.messages);
  const { touches, task, currentTurn } = collected;

  const leftAlone = leftAloneFor(input.store);
  for (const [id, turn] of leftAlone) if (turn !== currentTurn) leftAlone.delete(id);
  const recentlyLeft = collected.results.filter((result) => leftAlone.has(result.id));
  // Supersession needs no Jev call, so a left-alone read that a later edit
  // replaced can still be stubbed.
  const nowSuperseded = findSuperseded(recentlyLeft, touches);
  const results = collected.results.filter(
    (result) => !leftAlone.has(result.id) || nowSuperseded.has(result.id),
  );

  // Relaxed eligibility, because that is what a forced sweep would act on.
  const eligibleCount = selectEligible(results, input.store.get(), input.config, { minTurnsAgo: 1 }).length;
  const fraction = input.contextFraction;
  const forced =
    fraction !== null &&
    fraction >= input.config.contextLevel &&
    eligibleCount > 0 &&
    (input.lastForcedFraction === null ||
      fraction >= input.lastForcedFraction + FORCE_STEP ||
      eligibleCount > (input.lastForcedEligible ?? 0));
  const trigger: "cost" | "context" | null = forced
    ? "context"
    : currentTurn >= input.cooldownUntilTurn
      ? "cost"
      : null;

  if (trigger === null) {
    return { ...unchanged, messages: withDecisions(input.messages, input.store) };
  }

  // T_after is the whole suffix (spec §6.1): every message's tokens from the
  // earliest changed result to the end, not just tool-result tokens.
  const tokensByIndex = new Map<number, number>();
  input.messages.forEach((message, index) => {
    tokensByIndex.set(index, messageTokens(message.content));
  });
  const outcome = await runSweep({
    results,
    decided: input.store.get(),
    touches,
    task,
    afterResultFor: (result) =>
      touches
        .filter((touch) => touch.messageIndex > result.messageIndex)
        .map((touch) => `${touch.kind} ${touch.path}`)
        .join("; "),
    tokensAfter: (messageIndex) => {
      let sum = 0;
      for (const [index, tokens] of tokensByIndex) if (index >= messageIndex) sum += tokens;
      return sum;
    },
    callsSoFar: input.callsSoFar,
    prices: input.prices,
    config: input.config,
    client: input.client,
    currentTurn,
    trigger,
    signal: input.signal,
  });

  input.store.add(outcome.decisions);
  for (const id of Object.keys(outcome.probabilitiesById)) {
    if (!input.store.get().has(id)) leftAlone.set(id, currentTurn);
  }

  return {
    messages: withDecisions(input.messages, input.store),
    sweep: outcome,
    trigger: outcome.decisions.length > 0 ? trigger : null,
    // Only a refused post-gate cools down; a Jev failure retries at the next trigger.
    cooldownUntilTurn:
      outcome.reason === "post-gate" ? currentTurn + COOLDOWN_TURNS : input.cooldownUntilTurn,
    lastForcedFraction: forced ? fraction : input.lastForcedFraction,
    lastForcedEligible: forced ? eligibleCount : input.lastForcedEligible,
  };
}