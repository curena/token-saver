import type { Chunk, ResultRef } from "./types.js";
import { pathOf } from "./policy/staleness.js";

const MARKER = "[token-saver]";

/** Budget for a command description. A path is never truncated: it is the one
 *  part of a stub the agent needs intact to decide whether to recall it. */
const MAX_COMMAND_DESCRIPTION = 60;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function describeResult(result: ResultRef): string {
  const path = pathOf(result);
  if (path !== null) return `${result.toolName} ${path}`;
  const command = result.input.command;
  if (typeof command === "string") {
    const head = command.split("\n")[0]!;
    // Truncate the whole composed string, not just the command: an MCP tool
    // name can be longer than the budget on its own.
    return truncate(`${result.toolName}: ${head}`, MAX_COMMAND_DESCRIPTION);
  }
  return result.toolName;
}

function approxTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tok` : `~${tokens} tok`;
}

export function renderStub(result: ResultRef, lineCount: number): string {
  return (
    `${MARKER} ${describeResult(result)}: ${lineCount} lines (${approxTokens(result.tokens)}) ` +
    `elided as no longer needed. recall({id:"${result.id}"}) to restore; startLine/endLine for part.`
  );
}

export function renderPartial(result: ResultRef, chunks: Chunk[], keptChunks: number[]): string {
  const kept = new Set(keptChunks);
  const lines: string[] = [
    `${MARKER} ${describeResult(result)}: showing lines still relevant; ` +
      `recall({id:"${result.id}", startLine, endLine}) for gaps.`,
  ];

  let gapStart: number | null = null;
  const flushGap = (endLine: number) => {
    if (gapStart === null) return;
    lines.push(`… lines ${gapStart}–${endLine} elided …`);
    gapStart = null;
  };

  for (const chunk of chunks) {
    if (kept.has(chunk.index)) {
      flushGap(chunk.startLine - 1);
      chunk.text.split("\n").forEach((line, offset) => {
        lines.push(`${String(chunk.startLine + offset).padStart(4, " ")}| ${line}`);
      });
    } else if (gapStart === null) {
      gapStart = chunk.startLine;
    }
  }
  flushGap(chunks.at(-1)?.endLine ?? 0);

  return lines.join("\n");
}
