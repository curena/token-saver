import { readFileSync } from "node:fs";

export interface SessionSource {
  file: string;
  text: string;
}

/**
 * Read each session file exactly once so every tau run shares one stable
 * snapshot. Without this, a file that grows between tau iterations (for
 * example a live session being appended to) skews the later iterations.
 */
export function readSessionFiles(
  files: string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): SessionSource[] {
  return files.map((file) => ({ file, text: read(file) }));
}