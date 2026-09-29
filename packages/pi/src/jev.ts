import type { JevClient } from "@token-saver/prune";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Plain fetch rather than the SDK: prune builds plain-JSON requests, which the HTTP API takes as-is. */
export function sdkClient(apiKey: string | undefined): JevClient | null {
  if (apiKey === undefined || apiKey.length === 0) return null;
  return {
    async systemOne(request, options) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: options?.signal,
      });
      if (!response.ok) throw new Error(`typesafe ${response.status}`);
      return (await response.json()) as { answers: Record<string, { noul: number }> };
    },
  };
}
