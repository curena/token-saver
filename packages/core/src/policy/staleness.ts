import type { ResultRef } from "../types.js";

export interface FileTouch {
  path: string;
  messageIndex: number;
  kind: "read" | "edit" | "write";
}

export function pathOf(result: ResultRef): string | null {
  const input = result.input;
  for (const key of ["path", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
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
      (touch) => touch.path === path && touch.messageIndex > result.messageIndex,
    );
    if (later) superseded.add(result.id);
  }
  return superseded;
}
