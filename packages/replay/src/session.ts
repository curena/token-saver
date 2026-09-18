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
  const callsById = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  let userTurn = 0;
  let latestAssistantText = "";
  let messageIndex = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message === undefined) continue;
    const message = entry.message;
    messageIndex++;

    if (message.role === "user") {
      userTurn++;
      userMessages.push(textOf(message.content));
      continue;
    }

    if (message.role === "toolResult") {
      const call = callsById.get(message.toolCallId ?? "");
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
      continue;
    }

    if (message.role !== "assistant") continue;

    // A call site is the context as it stood when the model was asked to produce
    // THIS message, so it is recorded before this message's own tool calls are.
    const workingFiles = [...new Set(
      touches.filter((t) => t.kind !== "read").map((t) => t.path),
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
    });

    latestAssistantText = textOf(message.content);

    for (const block of Array.isArray(message.content) ? message.content : []) {
      const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
      if (call.type !== "toolCall" || call.id === undefined || call.name === undefined) continue;
      const args = call.arguments ?? {};
      callsById.set(call.id, { name: call.name, args, turn: userTurn });
      const kind = TOUCH_KIND[call.name];
      const path = pathArg(args);
      if (kind !== undefined && path !== null) touches.push({ path, messageIndex, kind });
    }
  }

  return sites;
}

export function afterResultSummary(site: CallSite, result: ResultRef): string {
  const later = site.touches.filter((touch) => touch.messageIndex > result.messageIndex);
  if (later.length === 0) return "";
  return later.map((touch) => `${touch.kind} ${touch.path}`).join("; ");
}