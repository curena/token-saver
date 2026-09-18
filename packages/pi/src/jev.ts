import type { JevClient, JevRequest } from "@token-saver/core";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Plain fetch rather than the SDK: core builds plain-JSON requests, which the HTTP API takes as-is. */
export function sdkClient(apiKey: string | undefined): JevClient | null {
  if (apiKey === undefined || apiKey.length === 0) return null;
  return {
    async systemOne(request: JevRequest, signal?: AbortSignal) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(`typesafe ${response.status}`);
      return (await response.json()) as { answers: Record<string, { noul: number }> };
    },
  };
}
