import { estimateTokens } from "@token-saver/core";
import type { FileTouch, ResultRef } from "@token-saver/core";

interface Entry {
  type: string;
  id: string;
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    model?: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
}

export interface CallSite {
  entryIndex: number;
  results: ResultRef[];
  touches: FileTouch[];
  userTurn: number;
  recentUserMessages: string[];
  latestAssistantText: string;
  workingFiles: string[];
  model: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Estimated tokens of every message seen so far, keyed by messageIndex (index 0 unused). */
  tokenCounts: number[];
  /** The previous message is the user's: pi's turn trigger can fire here. */
  atTurnStart: boolean;
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

/** Everything the message puts in the context: its text plus any tool-call arguments. */
function contextTextOf(content: unknown): string {
  const parts = [textOf(content)];
  for (const block of Array.isArray(content) ? content : []) {
    const call = block as { type?: string; arguments?: unknown };
    if (call.type === "toolCall") parts.push(JSON.stringify(call.arguments ?? {}));
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

function lineArg(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function pathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function parseSession(jsonl: string): CallSite[] {
  const entries: Entry[] = jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Entry);

  const sites: CallSite[] = [];
  const results: ResultRef[] = [];
  const touches: FileTouch[] = [];
  const userMessages: string[] = [];
  const tokenCounts: number[] = [0]; // tokenCounts[messageIndex]; 0 is a never-used sentinel
  // Touches are copied into each call site, so an outcome is recorded by
  // replacing the touch object, never by mutating one a site already holds.
  const touchIndexById = new Map<string, number>();
  const callsById = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  let userTurn = 0;
  let latestAssistantText = "";
  let messageIndex = 0;
  let previousRole = "";

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message === undefined) continue;
    const message = entry.message;
    const atTurnStart = previousRole === "user";
    messageIndex++;
    const messageTokens = estimateTokens(contextTextOf(message.content));

    if (message.role !== "assistant") tokenCounts[messageIndex] = messageTokens;

    if (message.role === "user") {
      userTurn++;
      userMessages.push(textOf(message.content));
      previousRole = message.role;
      continue;
    }

    if (message.role === "toolResult") {
      const call = callsById.get(message.toolCallId ?? "");
      const touchIndex = touchIndexById.get(message.toolCallId ?? "");
      if (touchIndex !== undefined) {
        touches[touchIndex] = { ...touches[touchIndex]!, isError: message.isError === true };
      }
      const text = textOf(message.content);
      results.push({
        id: message.toolCallId ?? `unknown_${messageIndex}`,
        toolName: message.toolName ?? call?.name ?? "unknown",
        input: call?.args ?? {},
        text,
        tokens: estimateTokens(text),
        messageIndex,
        turnsAgo: 0, // filled per call site below
        isError: message.isError === true,
      });
      previousRole = message.role;
      continue;
    }

    if (message.role !== "assistant") {
      previousRole = message.role;
      continue;
    }

    // A call site is the context as it stood when the model was asked to produce
    // THIS message, so it is recorded before this message's own tool calls are.
    const workingFiles = [...new Set(
      touches.filter((t) => t.kind !== "read" && t.isError !== true).map((t) => t.path),
    )];

    sites.push({
      entryIndex: messageIndex,
      results: results.map((result) => ({
        ...result,
        turnsAgo: userTurn - (callsById.get(result.id)?.turn ?? userTurn),
      })),
      touches: [...touches],
      userTurn,
      recentUserMessages: [...userMessages],
      latestAssistantText,
      workingFiles,
      model: message.model ?? "unknown",
      usage: message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tokenCounts: [...tokenCounts],
      atTurnStart,
    });

    // Only now does this message join the context seen by later calls.
    tokenCounts[messageIndex] = messageTokens;
    latestAssistantText = textOf(message.content) || latestAssistantText;
    previousRole = message.role;

    for (const block of Array.isArray(message.content) ? message.content : []) {
      const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
      if (call.type !== "toolCall" || call.id === undefined || call.name === undefined) continue;
      const args = call.arguments ?? {};
      callsById.set(call.id, { name: call.name, args, turn: userTurn });
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
      touchIndexById.set(call.id, touches.length);
      touches.push(touch);
    }
  }

  return sites;
}

export function afterResultSummary(site: CallSite, result: ResultRef): string {
  const later = site.touches.filter((touch) => touch.messageIndex > result.messageIndex);
  if (later.length === 0) return "";
  return later.map((touch) => `${touch.kind} ${touch.path}`).join("; ");
}