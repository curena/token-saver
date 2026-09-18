import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../core/redact.js";

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

function* records(dir: string): Generator<TranscriptRecord> {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    // Permissions, or `dir` turned out not to be a directory after all.
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    let contents: string;
    try {
      contents = readFileSync(join(dir, file), "utf8");
    } catch {
      // Permissions, or `file` is a directory named like a transcript.
      continue;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      // Valid JSON but not a record shape (null, an array, a bare string/number) — skip it
      // rather than crash on `record.type` below.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      yield parsed as TranscriptRecord;
    }
  }
}

/** "superpowers:brainstorming" and "brainstorming" both count as "brainstorming". */
function bareName(skill: string): string {
  const at = skill.lastIndexOf(":");
  return at === -1 ? skill : skill.slice(at + 1);
}

export function countSkillUses(transcriptDir: string, since: Date): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records(transcriptDir)) {
    if (record.type !== "assistant") continue;
    const at = record.timestamp ? new Date(record.timestamp) : null;
    if (!at || Number.isNaN(at.getTime()) || at < since) continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as any[]) {
      if (block?.type !== "tool_use" || block?.name !== "Skill") continue;
      const skill = block?.input?.skill;
      if (typeof skill !== "string") continue;
      const id = bareName(skill);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function recentPrompts(transcriptDir: string, limit: number): string[] {
  const prompts: { at: number; text: string }[] = [];
  for (const record of records(transcriptDir)) {
    if (record.type !== "user") continue;
    const content = record.message?.content;
    let text: string | null = null;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = (content as any[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    if (!text || !text.trim()) continue;
    prompts.push({
      at: record.timestamp ? Date.parse(record.timestamp) : 0,
      text: redact(text.trim()),
    });
  }
  return prompts.sort((a, b) => b.at - a.at).slice(0, limit).map((p) => p.text);
}
