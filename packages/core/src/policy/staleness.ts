import type { ResultRef } from "../types.js";

export interface FileTouch {
  path: string;
  messageIndex: number;
  kind: "read" | "edit" | "write";
  /** Read touches only: the call's 1-based start line; absent means line 1. */
  offset?: number;
  /** Read touches only: the call's line count; absent means to end of file. */
  limit?: number;
  /** True when the call's result was an error. A failed touch changes nothing. */
  isError?: boolean;
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

/** A read's inclusive line span; `end` is Infinity when it runs to end of file. */
interface LineSpan {
  start: number;
  end: number;
}

function lineNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function spanOf(offset: unknown, limit: unknown): LineSpan {
  const start = Math.max(1, lineNumber(offset) ?? 1);
  const count = lineNumber(limit);
  return { start, end: count === null ? Infinity : start + Math.max(0, count) - 1 };
}

/**
 * A later touch makes an earlier read out of date only if it actually replaced
 * what the read put in context: a successful edit or write always does; a
 * successful read does only when its span covers the earlier read's span.
 * Failed calls change nothing on disk and bring nothing into context.
 */
function supersedes(touch: FileTouch, earlier: LineSpan): boolean {
  if (touch.isError === true) return false;
  if (touch.kind !== "read") return true;
  const later = spanOf(touch.offset, touch.limit);
  return later.start <= earlier.start && later.end >= earlier.end;
}

export function findSuperseded(results: ResultRef[], touches: FileTouch[]): Set<string> {
  const superseded = new Set<string>();
  for (const result of results) {
    if (result.toolName !== "read") continue;
    const path = pathOf(result);
    if (path === null) continue;
    const span = spanOf(result.input.offset, result.input.limit);
    const later = touches.some(
      (touch) =>
        normalizePath(touch.path) === path &&
        touch.messageIndex > result.messageIndex &&
        supersedes(touch, span),
    );
    if (later) superseded.add(result.id);
  }
  return superseded;
}
