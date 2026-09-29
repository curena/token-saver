import type { Chunk } from "@token-saver/prune";

export interface LaterUse {
  text: string;
  kind: "assistant" | "edit" | "command";
}

export interface Miss {
  resultId: string;
  chunkIndex: number;
  probability: number;
  evidence: LaterUse["kind"];
}

const MIN_LINE = 12;

export function collectLaterUses(jsonl: string, afterMessageIndex: number): LaterUse[] {
  const uses: LaterUse[] = [];
  let messageIndex = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } };
    if (entry.type !== "message" || entry.message === undefined) continue;
    messageIndex++;
    if (messageIndex <= afterMessageIndex) continue;
    if (entry.message.role !== "assistant") continue;

    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        uses.push({ text: typed.text, kind: "assistant" });
      } else if (typed.type === "toolCall") {
        uses.push({
          text: JSON.stringify(typed.arguments ?? {}),
          kind: typed.name === "bash" ? "command" : "edit",
        });
      }
    }
  }
  return uses;
}

export function detectMisses(
  resultId: string,
  chunks: Chunk[],
  probabilities: number[],
  elided: number[],
  laterUses: LaterUse[],
): Miss[] {
  const misses: Miss[] = [];
  for (const index of elided) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const lines = chunk.text.split("\n").map((line) => line.trim()).filter((line) => line.length >= MIN_LINE);
    const hit = laterUses.find((use) => lines.some((line) => use.text.includes(line)));
    if (hit !== undefined) {
      misses.push({ resultId, chunkIndex: index, probability: probabilities[index] ?? 0, evidence: hit.kind });
    }
  }
  return misses;
}