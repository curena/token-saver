export interface RecallSource {
  findResultText(toolCallId: string): string | null;
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
  return {
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
  const lines = text.split("\n");
  const start = Math.max(1, params.startLine ?? 1);
  const end = Math.min(lines.length, params.endLine ?? lines.length);
  return { content: [{ type: "text", text: lines.slice(start - 1, end).join("\n") }], isError: false };
}