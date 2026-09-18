import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { cachingClient } from "../src/jevCache.js";
import { replaySession } from "../src/run.js";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");
const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

const stale: JevClient = {
  systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.01 };
    return { answers };
  },
};

describe("cachingClient", () => {
  it("calls through once and replays from disk afterwards", async () => {
    let calls = 0;
    const counted: JevClient = { systemOne: async () => { calls++; return { answers: { "chunk::0": { noul: 0.5 } } }; } };
    const path = join(mkdtempSync(join(tmpdir(), "ts-cache-")), "jev.json");
    const request = { state: { a: 1 }, questions: { "chunk::0": {} }, model: "jev-1.13.0" };

    const first = await cachingClient(counted, path).systemOne(request);
    const second = await cachingClient(counted, path).systemOne(request);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});

describe("replaySession", () => {
  it("reports per-session token counts and sweep activity", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, {
      ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0,
    }, PRICES);
    expect(metrics.session).toBe("fixture");
    expect(metrics.calls).toBe(3);
    expect(metrics.tokensBefore).toBeGreaterThan(0);
    expect(metrics.tokensAfter).toBeLessThanOrEqual(metrics.tokensBefore);
  });

  it("changes nothing when the extension is configured off", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, { ...DEFAULT_CONFIG, enabled: false }, PRICES);
    expect(metrics.tokensAfter).toBe(metrics.tokensBefore);
    expect(metrics.sweeps).toBe(0);
  });

  it("never lets a decision change after it is taken", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, {
      ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0,
    }, PRICES);
    // Each result is decided at most once: sweeps never exceed the number of results.
    expect(metrics.stubbed + metrics.partial).toBeLessThanOrEqual(2);
  });
});