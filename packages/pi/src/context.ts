import { emergencyLevel, estimateTokens, findSuperseded, nextArmAt, runSweep, turnLevel } from "@token-saver/prune";
import type { Config, FileTouch, JevClient, ResultRef, SweepOutcome, TaskState } from "@token-saver/prune";
import type { DecisionStore } from "./state.js";

export interface PiMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface Usage {
  tokens: number;
  window: number;
}

/** Arm points for the next sweep; null means "use the config-derived base level". */
export interface Arming {
  turnArmAt: number | null;
  emergencyArmAt: number | null;
}

export interface HandleInput {
  messages: PiMessage[];
  store: DecisionStore;
  config: Config;
  client: JevClient | null;
  usage: Usage | null;
  reserveTokens: number;
  arming: Arming;
  signal?: AbortSignal;
}

export interface HandleOutput {
  messages: PiMessage[] | null;
  sweep: SweepOutcome | null;
  trigger: "turn" | "context" | null;
  arming: Arming;
  /** Why no sweep ran, for /token-saver status. null when a sweep ran. */
  idle: "disabled" | "no-usage" | "below-level" | "mid-run" | null;
}

const TOUCH_KIND: Record<string, FileTouch["kind"]> = { read: "read", edit: "edit", write: "write" };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function lineArg(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Results Jev judged and left alone, with the user turn they were judged in.
 * Within one agent run the user turn does not advance, so a mid-run trigger
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

const BASE_ARMING: Arming = { turnArmAt: null, emergencyArmAt: null };

export async function handleContext(input: HandleInput): Promise<HandleOutput> {
  const idle = (reason: NonNullable<HandleOutput["idle"]>, arming: Arming = input.arming): HandleOutput => ({
    messages: withDecisions(input.messages, input.store),
    sweep: null, trigger: null, arming, idle: reason,
  });
  // Decisions are immutable: "/token-saver off" stops sweeps but existing
  // stubs stay applied (spec §7); only the sweep is gated on `enabled`.
  if (!input.config.enabled || input.client === null) return idle("disabled");
  // pi reports null usage right after compaction; treat that as a clean slate
  // rather than carrying stale arm points into the next real reading.
  if (input.usage === null) return idle("no-usage", BASE_ARMING);

  const { tokens, window } = input.usage;
  const { config, reserveTokens } = input;
  const turnBase = turnLevel(window, reserveTokens, config) * window;
  const emergencyBase = emergencyLevel(window, reserveTokens, config.contextLevel) * window;
  const compactionPoint = window - reserveTokens;
  // The context has shrunk back to (or below) the sweep target — most likely
  // pi just compacted — so arm points raised before that no longer apply.
  const arming = tokens <= config.lowWater * window ? BASE_ARMING : input.arming;
  const turnArmAt = arming.turnArmAt ?? turnBase;
  const emergencyArmAt = arming.emergencyArmAt ?? emergencyBase;

  // The first context of a turn ends with the user's message; mid-run ones end
  // with a tool result. Sweeping only there puts the re-processing wait where
  // the user already expects a pause. A queued/steering user message sent
  // mid-run also ends the context with role "user", so it counts as a turn start.
  const atTurnStart = input.messages.at(-1)?.role === "user";
  const trigger: "turn" | "context" | null =
    tokens >= emergencyArmAt ? "context" : atTurnStart && tokens >= turnArmAt ? "turn" : null;
  if (trigger === null) return idle(atTurnStart ? "below-level" : "mid-run", arming);

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
    currentTokens: tokens,
    targetTokens: config.lowWater * window,
    config,
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
    arming: {
      // Capped at the emergency base, not Infinity: a turn trigger that falls
      // short must not be able to re-arm past the point the emergency trigger
      // would fire anyway.
      turnArmAt: nextArmAt(outcome.reached, window, config, turnBase, emergencyBase),
      // Spec §2.1: the emergency trigger re-arms only after it fires itself; a
      // turn sweep that falls short must not push it toward the compaction point.
      emergencyArmAt: trigger === "context"
        ? nextArmAt(outcome.reached, window, config, emergencyBase, compactionPoint)
        : arming.emergencyArmAt,
    },
    idle: null,
  };
}
