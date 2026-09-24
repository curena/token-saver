import { readFileSync } from "node:fs";
import { DEFAULT_RESERVE_TOKENS } from "@token-saver/core";

/**
 * pi's `compaction.reserveTokens` from its settings files (global, then project).
 * Extensions aren't handed pi's settings, so read the same files pi does.
 */
export function readReserveTokens(files: string[]): number {
  let reserve = DEFAULT_RESERVE_TOKENS;
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { compaction?: { reserveTokens?: unknown } };
      const value = parsed.compaction?.reserveTokens;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) reserve = value;
    } catch {
      // missing or malformed settings never break a session
    }
  }
  return reserve;
}
