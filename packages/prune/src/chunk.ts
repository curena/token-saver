import type { Chunk } from "./types.js";
import { estimateTokens } from "@token-saver/core";

/**
 * `isBoundary(line, previous)` answers "does a new chunk start AT `line`?".
 * Blank-line separation keys off `previous`, so the blank ends the chunk
 * before it rather than heading the chunk after it. A blank line never starts
 * a chunk, so a run of several blanks stays wholly at the tail of the chunk
 * it closes.
 */
interface Shape {
  min: number;
  max: number;
  isBoundary: (line: string, previous: string | undefined) => boolean;
}

const DECLARATION = /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum|def|impl|fn|struct|public|private|protected)\b/;

const SHAPES: Record<string, Shape> = {
  read: {
    min: 20,
    max: 60,
    isBoundary: (line, previous) =>
      DECLARATION.test(line) ||
      (previous !== undefined && previous.trim() === "" && line.trim() !== ""),
  },
  bash: {
    min: 20,
    max: 40,
    isBoundary: (line, previous) =>
      previous !== undefined &&
      line.trim() !== "" &&
      (previous.trim() === "" || prefix(line) !== prefix(previous)),
  },
  generic: { min: 40, max: 40, isBoundary: () => false },
};

/** Leading non-alphanumeric run plus first word: a cheap "does this line look like the last one". */
function prefix(line: string): string {
  return line.slice(0, 12).replace(/[0-9]+/g, "#");
}

export function chunkResult(toolName: string, text: string, firstLine = 1): Chunk[] {
  if (text.length === 0) return [];
  const shape = SHAPES[toolName] ?? SHAPES.generic!;
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let start = 0;

  for (let i = 1; i <= lines.length; i++) {
    const size = i - start;
    const atEnd = i === lines.length;
    const boundary =
      size >= shape.min && !atEnd && shape.isBoundary(lines[i]!, lines[i - 1]);
    if (atEnd || boundary || size >= shape.max) {
      const slice = lines.slice(start, i);
      const body = slice.join("\n");
      chunks.push({
        index: chunks.length,
        startLine: firstLine + start,
        endLine: firstLine + i - 1,
        text: body,
        tokens: estimateTokens(body),
      });
      start = i;
    }
  }
  return chunks;
}
