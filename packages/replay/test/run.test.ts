import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { cachingClient } from "../src/jevCache.js";
import { replaySession } from "../src/run.js";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");

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
    }, { window: 1_000, reserveTokens: 0 });
    expect(metrics.session).toBe("fixture");
    expect(metrics.calls).toBe(3);
    expect(metrics.tokensBefore).toBeGreaterThan(0);
    expect(metrics.tokensAfter).toBeLessThanOrEqual(metrics.tokensBefore);
  });

  it("changes nothing when the extension is configured off", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, { ...DEFAULT_CONFIG, enabled: false }, { window: 1_000, reserveTokens: 0 });
    expect(metrics.tokensAfter).toBe(metrics.tokensBefore);
    expect(metrics.sweeps).toBe(0);
  });

  it("never lets a decision change after it is taken", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, {
      ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0,
    }, { window: 1_000, reserveTokens: 0 });
    // Each result is decided at most once: sweeps never exceed the number of results.
    expect(metrics.stubbed + metrics.partial).toBeLessThanOrEqual(2);
  });
});
describe("replaySession retention", () => {
  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0 };
  const quoted = "export function login(credentials: Credentials): Session {";

  it("does not count uses made while the result was still fully visible", async () => {
    // call_1 is only eligible at the third call (turnsAgo 1); "Now editing" is
    // written at the second call, while the result is still in full.
    const early = jsonl.replace('"text":"Now editing"', `"text":${JSON.stringify(`Now editing ${quoted}`)}`);
    const metrics = await replaySession(early, "fixture", stale, config, { window: 1_000, reserveTokens: 0 });
    expect(metrics.stubbed + metrics.partial).toBeGreaterThan(0);
    expect(metrics.misses).toEqual([]);
  });

  it("counts uses made after the sweep point", async () => {
    const late = jsonl.replace('"text":"Running"', `"text":${JSON.stringify(`Running ${quoted}`)}`);
    const metrics = await replaySession(late, "fixture", stale, config, { window: 1_000, reserveTokens: 0 });
    expect(metrics.misses.some((miss) => miss.resultId === "call_1")).toBe(true);
  });
});

describe("replaySession turn arm-point cap", () => {
  // Builds a session with one big, protected read result and three turn-start
  // calls, sized (with window 12,000 / reserve 800) so that:
  //   turnBase = 9,000   emergencyBase = 9,200   compactionPoint = 11,200
  // Turn 2 fires a "turn" trigger with nothing eligible yet (protectTurns: 1,
  // turnsAgo 1) — a sweep that "falls short": reached stays at 9,100, so the
  // arm point re-arms via the "later" branch to 14,500, and must be capped at
  // the emergency base (9,200), not left uncapped at 14,500. Turn 3's context
  // (10,001) sits strictly between the two: >= the correct cap, < the
  // uncapped value and < emergencyArmAt (11,200) — so only a correctly
  // capped turnArmAt lets turn 3 sweep at all.
  function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
  }

  const bigResult = "x".repeat(36376); // 9,094 tokens
  const midText = "x".repeat(3600); // 900 tokens

  const jsonl = [
    line("user", "a"), // 1 token
    line("assistant", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "f.ts" } }]), // 4 tokens
    line("toolResult", [{ type: "text", text: bigResult }], { toolCallId: "call_1", toolName: "read" }),
    line("user", "b"), // 1 token
    line("assistant", [{ type: "text", text: midText }]), // turn 2 call site; context here = 9,100
    line("user", "d"), // 1 token
    line("assistant", [{ type: "text", text: "done" }]), // turn 3 call site; context here = 10,001
  ].join("\n");

  const config = { ...DEFAULT_CONFIG, protectTurns: 1 };
  const options = { window: 12_000, reserveTokens: 800 };

  it("lets a later turn start above the emergency base sweep again after a short sweep", async () => {
    const metrics = await replaySession(jsonl, "arm-cap", stale, config, options);
    // Only reachable if turnArmAt was capped at the emergency base (9,200) at
    // turn 2, not left at the uncapped re-arm value (14,500): turn 3's context
    // (10,001) clears the former but not the latter, and never reaches
    // emergencyArmAt (11,200) either.
    expect(metrics.sweeps).toBe(1);
    expect(metrics.stubbed).toBe(1);
  });
});

describe("replaySession budget metrics", () => {
  it("skips sweeps and marks the session when the window is unknown", async () => {
    const metrics = await replaySession(jsonl, "s", stale, DEFAULT_CONFIG, { window: null, reserveTokens: 0 });
    expect(metrics.window).toBeNull();
    expect(metrics.sweeps).toBe(0);
    expect(metrics.jevRequests).toBe(0);
  });

  it("tracks peak context and compactions before and after", async () => {
    const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0 };
    const metrics = await replaySession(jsonl, "s", stale, config, { window: 1_000, reserveTokens: 0 });
    expect(metrics.peakBefore).toBeGreaterThan(0);
    expect(metrics.peakAfter).toBeLessThanOrEqual(metrics.peakBefore);
    expect(metrics.compactionsAfter).toBeLessThanOrEqual(metrics.compactionsBefore);
    if (metrics.sweeps > 0) expect(metrics.rewrittenTokens).toBeGreaterThan(0);
  });
});

describe("replaySession turn trigger fires only at a turn start", () => {
  // window 20,000 / reserve 0 gives DISTINCT levels (unlike the 1,000/2,000-window
  // tests above, where emergencyLevel <= 0 collapses turnBase === emergencyBase and
  // every sweep fires via "context"):
  //   turnBase = 15,000   emergencyBase = 17,000   compactionPoint = 20,000
  // call_1 (15,990 tokens) is the only eligible candidate. Its result lands the
  // context at 15,995-15,997 for two call sites: one mid-turn (not a turn start,
  // context in [turnBase, emergencyBase)) and one at the next turn's start. Only
  // the turn-start call site may fire a trigger here (context needs >= 17,000,
  // never reached); if the turn check ever fired without atTurnStart, the
  // mid-turn call would sweep first, at a call site whose tokenCounts snapshot
  // is two messages shorter, producing a smaller (and distinguishably wrong)
  // rewrittenTokens (15,990 instead of 15,992 - see below).
  function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
  }

  const bigResult = "x".repeat(63960); // 15,990 tokens

  const jsonl = [
    line("user", "a"), // 1 token
    line("assistant", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "f.ts" } }]), // 4 tokens
    line("toolResult", [{ type: "text", text: bigResult }], { toolCallId: "call_1", toolName: "read" }),
    line("assistant", "ok"), // 1 token; mid-turn call site (not a turn start): ctx before = 15,995
    line("user", "b"), // 1 token
    line("assistant", "done"), // turn-start call site: ctx before = 15,997
  ].join("\n");

  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0 };
  const options = { window: 20_000, reserveTokens: 0 };

  it("sweeps once, at the turn-start call site, not the earlier mid-turn one", async () => {
    const metrics = await replaySession(jsonl, "arm-cap-turn", stale, config, options);
    expect(metrics.sweeps).toBe(1);
    expect(metrics.stubbed + metrics.partial).toBe(1);
    // 15,990 (call_1) + 1 ("ok") + 1 ("b"): only reachable if the sweep landed at
    // the turn-start call site (tokenCounts includes "ok" and "b"), not the
    // mid-turn one two messages earlier (which would give 15,990).
    expect(metrics.rewrittenTokens).toBe(15_992);
  });
});

describe("replaySession compaction counters", () => {
  // window 10,000 / reserve 0: compactionPoint = 10,000, emergencyBase = 8,000,
  // lowWater*window = 3,000. call_1 (8,000 tokens) crosses emergencyBase at the
  // second call site and gets swept there, banking a large saving. A second,
  // untouched result (call_2, 3,000 tokens) then grows the RAW context past the
  // compaction point at a later call site, while the mitigated context - still
  // benefiting from call_1's earlier saving - stays under it: compactionsBefore
  // increments once, compactionsAfter never does.
  function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
  }

  const jsonl = [
    line("user", "a"), // 1 token
    line("assistant", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "f.ts" } }]), // 4 tokens
    line("toolResult", [{ type: "text", text: "x".repeat(32000) }], { toolCallId: "call_1", toolName: "read" }), // 8,000 tokens
    line("user", "b"), // 1 token; call site here: ctx before = 8,006 >= emergencyBase (8,000) -> sweeps call_1
    line("assistant", "ok"), // 1 token
    line("user", "c"), // 1 token
    line("assistant", [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "g.ts" } }]), // 4 tokens; call site here: ctx before = 8,008 (still under compactionPoint)
    line("toolResult", [{ type: "text", text: "x".repeat(12000) }], { toolCallId: "call_2", toolName: "read" }), // 3,000 tokens
    line("user", "d"), // 1 token
    line("assistant", "done"), // call site here: ctx before = 11,013 (over compactionPoint); ctx after stays well under it
  ].join("\n");

  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0 };
  const options = { window: 10_000, reserveTokens: 0 };

  it("counts a compaction the raw context would hit but the mitigated one avoids", async () => {
    const metrics = await replaySession(jsonl, "compaction-count", stale, config, options);
    expect(metrics.compactionsBefore).toBe(1);
    expect(metrics.compactionsAfter).toBe(0);
  });
});
