import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevClient } from "@token-saver/prune";

type Answers = { answers: Record<string, any> };

// Taken from the interface rather than spelled out: this wrapper keys on whatever a client
// is handed, which is the redacted request `Jev` builds, not the `JevRequest` prune built.
type Request = Parameters<JevClient["systemOne"]>[0];

function keyOf(request: Request): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

/**
 * Wrap a client so identical requests are answered from `cachePath` instead of the network.
 *
 * It sits below `Jev`, not above it, so the request it keys on is the redacted one that
 * would have gone over the wire. That is the right key: two sessions whose only difference
 * is a secret Jev never sees should share an answer, and the file this writes must not
 * become a place secrets accumulate on disk.
 */
export function cachingClient(client: JevClient, cachePath: string): JevClient {
  const load = (): Record<string, Answers> => {
    try {
      return JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Answers>;
    } catch {
      return {};
    }
  };

  return {
    async systemOne(request, options) {
      const cache = load();
      const key = keyOf(request);
      const hit = cache[key];
      if (hit !== undefined) return hit;

      const answer = await client.systemOne(request, options);
      cache[key] = answer;
      if (!existsSync(dirname(cachePath))) mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
      return answer;
    },
  };
}