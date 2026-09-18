import { describe, expect, it } from "vitest";
import { renderReport, summarize } from "../src/report.js";
import type { ReplayMetrics } from "../src/run.js";

function metrics(over: Partial<ReplayMetrics> = {}): ReplayMetrics {
  return {
    session: "s", calls: 10, tokensBefore: 100_000, tokensAfter: 60_000,
    sweeps: 2, stubbed: 3, partial: 1, jevRequests: 5, jevInputTokens: 20_000,
    rewrittenTokens: 50_000, sweepMs: 300, misses: [], ...over,
  };
}

describe("summarize", () => {
  it("totals the sessions and computes the saved percentage", () => {
    const total = summarize([metrics(), metrics({ tokensBefore: 100_000, tokensAfter: 80_000 })]);
    expect(total.tokensBefore).toBe(200_000);
    expect(total.tokensAfter).toBe(140_000);
    expect(total.savedPct).toBeCloseTo(30, 5);
  });

  it("counts misses across sessions", () => {
    const total = summarize([
      metrics({ misses: [{ resultId: "a", chunkIndex: 0, probability: 0.1, evidence: "assistant" }] }),
      metrics(),
    ]);
    expect(total.misses).toBe(1);
  });

  it("reports zero savings for an empty run", () => {
    expect(summarize([]).savedPct).toBe(0);
    expect(summarize([]).netUsd).toBe(0);
  });

  it("nets cache reads avoided against cache writes paid and Jev spend", () => {
    const prices = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
    const total = summarize([metrics()], prices);
    expect(total.jevUsd).toBeCloseTo(20_000 * (0.042 / 1e6), 10);
    // 40k tokens saved at cacheRead, 50k rewritten at cacheWrite: a net loss here.
    expect(total.netUsd).toBeCloseTo(
      40_000 * prices.cacheRead - 50_000 * prices.cacheWrite - total.jevUsd,
      10,
    );
    expect(total.netUsd).toBeLessThan(0);
  });
});

describe("renderReport", () => {
  it("writes one markdown row per tau with savings and misses", () => {
    const report = renderReport([
      { tau: 0.1, metrics: [metrics()] },
      { tau: 0.3, metrics: [metrics({ tokensAfter: 50_000, misses: [{ resultId: "a", chunkIndex: 1, probability: 0.2, evidence: "edit" }] })] },
    ]);
    expect(report).toContain("| tau |");
    expect(report).toContain("| 0.1 |");
    expect(report).toContain("| 0.3 |");
    expect(report).toMatch(/40\.0%/);
    expect(report).toContain("| net $ |");
  });
});
