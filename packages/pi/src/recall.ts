import { firstLineOf } from "@token-saver/core";
import type { ResultRef } from "@token-saver/core";

export interface RecallSource {
  findResultText(toolCallId: string): string | null;
  /**
   * The real file line the result's first line corresponds to (a read's
   * `offset`), so startLine/endLine match the sweep's elided markers. Defaults to 1.
   */
  firstLineOf?(toolCallId: string): number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function sessionSource(
  entries: Array<{ type: string; message?: { role: string; toolCallId?: string; content?: unknown } }>,
): RecallSource {
  const argsOf = (toolCallId: string): Record<string, unknown> => {
    for (const entry of entries) {
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const call = block as { type?: string; id?: string; arguments?: Record<string, unknown> };
        if (call.type === "toolCall" && call.id === toolCallId) return call.arguments ?? {};
      }
    }
    return {};
  };
  return {
    firstLineOf(toolCallId: string): number {
      // Same rule the sweep uses to number chunks, so recall and markers agree.
      return firstLineOf({ input: argsOf(toolCallId) } as ResultRef);
    },
    findResultText(toolCallId: string): string | null {
      for (const entry of entries) {
        const message = entry.message;
        if (entry.type !== "message" || message === undefined) continue;
        if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
        return textOf(message.content);
      }
      return null;
    },
  };
}

export function recall(
  source: RecallSource,
  params: { id: string; startLine?: number; endLine?: number },
): { content: [{ type: "text"; text: string }]; isError: boolean } {
  const text = source.findResultText(params.id);
  if (text === null) {
    return {
      content: [{ type: "text", text: `No stored tool result with id "${params.id}".` }],
      isError: true,
    };
  }
  if (params.startLine === undefined && params.endLine === undefined) {
    return { content: [{ type: "text", text }], isError: false };
  }
  // startLine/endLine are real file lines (as in the elided markers); convert
  // them to 1-based positions within the result text.
  const shift = (source.firstLineOf?.(params.id) ?? 1) - 1;
  const lines = text.split("\n");
  const start = Math.max(1, (params.startLine ?? 1 + shift) - shift);
  const end = Math.min(lines.length, (params.endLine ?? lines.length + shift) - shift);
  return { content: [{ type: "text", text: lines.slice(start - 1, end).join("\n") }], isError: false };
}