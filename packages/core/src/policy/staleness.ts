import type { ResultRef } from "../types.js";

export interface FileTouch {
  path: string;
  messageIndex: number;
  kind: "read" | "edit" | "write";
}

/**
 * The two sides of a supersede check come from different tools' arguments, so
 * the same file arrives as "src/a.ts" from one and "./src/a.ts" from another.
 * Settle the spellings that do not need a working directory. Case is left
 * alone deliberately: the target filesystems are case-sensitive, and folding
 * it would supersede a different file that happens to differ only in case.
 */
export function normalizePath(path: string): string {
  let out = path.replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out;
}

export function pathOf(result: ResultRef): string | null {
  const input = result.input;
  for (const key of ["path", "file_path"]) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const normalized = normalizePath(value);
    if (normalized.length > 0) return normalized;
  }
  return null;
}

export function findSuperseded(results: ResultRef[], touches: FileTouch[]): Set<string> {
  const superseded = new Set<string>();
  for (const result of results) {
    if (result.toolName !== "read") continue;
    const path = pathOf(result);
    if (path === null) continue;
    const later = touches.some(
      (touch) => normalizePath(touch.path) === path && touch.messageIndex > result.messageIndex,
    );
    if (later) superseded.add(result.id);
  }
  return superseded;
}
