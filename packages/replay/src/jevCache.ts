import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevClient, JevRequest } from "@token-saver/core";

type Answers = { answers: Record<string, { noul: number }> };

function keyOf(request: JevRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function cachingClient(client: JevClient, cachePath: string): JevClient {
  const load = (): Record<string, Answers> => {
    try {
      return JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Answers>;
    } catch {
      return {};
    }
  };

  return {
    async systemOne(request, signal) {
      const cache = load();
      const key = keyOf(request);
      const hit = cache[key];
      if (hit !== undefined) return hit;

      const answer = await client.systemOne(request, signal);
      cache[key] = answer;
      if (!existsSync(dirname(cachePath))) mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
      return answer;
    },
  };
}