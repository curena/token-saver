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
  // The fixture's recorded usage is 2,000 / 3,100 / 5,100 tokens at its three
  // calls. Window 10,000 with highWater 0.5 puts the turn trigger at 5,000 and
  // the emergency trigger at 8,000, so the only sweep is the turn sweep at the
  // third call (a turn start), where call_1 is eligible (turnsAgo 1).
  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0, highWater: 0.5 };
  const options = { window: 10_000, reserveTokens: 0 };
  const quoted = "export function login(credentials: Credentials): Session {";

  it("does not count uses made while the result was still fully visible", async () => {
    // call_1 is only eligible at the third call (turnsAgo 1); "Now editing" is
    // written at the second call, while the result is still in full.
    const early = jsonl.replace('"text":"Now editing"', `"text":${JSON.stringify(`Now editing ${quoted}`)}`);
    const metrics = await replaySession(early, "fixture", stale, config, options);
    expect(metrics.stubbed + metrics.partial).toBeGreaterThan(0);
    expect(metrics.misses).toEqual([]);
  });

  it("counts uses made after the sweep point", async () => {
    const late = jsonl.replace('"text":"Running"', `"text":${JSON.stringify(`Running ${quoted}`)}`);
    const metrics = await replaySession(late, "fixture", stale, config, options);
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
    // call_1 at its post-sweep (stub) size — 15,990 minus its 15,950 saving,
    // i.e. the 40-token stub overhead — + 1 ("ok") + 1 ("b"): only reachable if
    // the sweep landed at the turn-start call site (tokenCounts includes "ok"
    // and "b"), not the mid-turn one two messages earlier (which would give 40).
    expect(metrics.rewrittenTokens).toBe(42);
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

describe("replaySession emergency re-arm", () => {
  // window 100,000 / reserve 16,384: turnBase 75,000, emergencyBase 81,616,
  // compactionPoint 83,616, lowWater 30,000. No recorded usage, so the context
  // is the chars/4 estimate.
  //  - call_1 (2,000 tokens, turn 1) is the only result a turn sweep may take
  //    at turn 4 (protectTurns 2: turnsAgo > 2); call_2 (8,000 tokens, turn 2)
  //    is eligible only for the emergency trigger (turnsAgo > 1).
  //  - Turn 4 starts at ~76,012: the turn sweep stubs call_1 and falls short
  //    (~74,0xx). Spec §2.1: that must not re-arm the emergency trigger.
  //  - Mid-run, call_3 (8,000 tokens) lands the context at ~82,0xx: above the
  //    emergency base, below where a wrongly re-armed emergencyArmAt (83,616)
  //    would sit. The emergency sweep must fire and take call_2.
  function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
  }

  const jsonl = [
    line("user", "a"),
    line("assistant", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "f.ts" } }]),
    line("toolResult", [{ type: "text", text: "x".repeat(8_000) }], { toolCallId: "call_1", toolName: "read" }),
    line("user", "b"),
    line("assistant", [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "g.ts" } }]),
    line("toolResult", [{ type: "text", text: "x".repeat(32_000) }], { toolCallId: "call_2", toolName: "read" }),
    line("user", "b2"),
    line("assistant", [{ type: "text", text: "y".repeat(264_000) }]), // 66,000 tokens of assistant output
    line("user", "c"),
    line("assistant", [{ type: "text", text: "ok" }, { type: "toolCall", id: "call_3", name: "bash", arguments: { command: "ls" } }]), // turn-start site
    line("toolResult", [{ type: "text", text: "x".repeat(32_000) }], { toolCallId: "call_3", toolName: "bash" }),
    line("assistant", [{ type: "text", text: "done" }]), // mid-run site
  ].join("\n");

  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, minSaving: 0 };
  const options = { window: 100_000, reserveTokens: 16_384 };

  it("a short turn sweep leaves the emergency trigger at its base, so a later mid-run call fires it", async () => {
    const metrics = await replaySession(jsonl, "emergency-rearm", stale, config, options);
    expect(metrics.sweeps).toBe(2);
    expect(metrics.stubbed).toBe(2);
  });
});

describe("replaySession context from recorded usage", () => {
  // window 100,000 / reserve 16,384: emergencyBase 81,616, compactionPoint 83,616.
  // The chars/4 estimate of this session never passes ~2,010 tokens, but the
  // recorded provider usage (input + cacheRead + cacheWrite, which includes the
  // system prompt and tool schemas) reaches 85,000 at the last call. pi triggers
  // on the latter, so replay must too.
  function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
  }
  const usage = (input: number, cacheRead: number, cacheWrite: number) =>
    ({ usage: { input, output: 10, cacheRead, cacheWrite } });

  function session(lastUsage: Record<string, unknown>): string {
    return [
      line("user", "a"),
      line("assistant", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "f.ts" } }], usage(20_000, 0, 0)),
      line("toolResult", [{ type: "text", text: "x".repeat(8_000) }], { toolCallId: "call_1", toolName: "read" }), // 2,000 tokens
      line("user", "b"),
      line("assistant", "k", usage(1_000, 20_000, 9_000)), // 30,000
      line("user", "c"),
      line("assistant", "ok", lastUsage), // call_1 is now turnsAgo 2: eligible for the emergency trigger
    ].join("\n");
  }

  const config = { ...DEFAULT_CONFIG, minResultTokens: 1, minSaving: 0 };
  const options = { window: 100_000, reserveTokens: 16_384 };

  it("triggers on recorded usage, not the estimate, and measures context from it", async () => {
    const metrics = await replaySession(session(usage(1_000, 80_000, 4_000)), "usage", stale, config, options);
    expect(metrics.sweeps).toBe(1);
    expect(metrics.peakBefore).toBe(85_000);
    expect(metrics.contextSumBefore).toBe(20_000 + 30_000 + 85_000);
    // call_1 stubbed: 2,000 tokens minus the 40-token stub overhead saved.
    expect(metrics.peakAfter).toBe(85_000 - 1_960);
    // 85,000 is past the compaction point; 83,040 is not.
    expect(metrics.compactionsBefore).toBe(1);
    expect(metrics.compactionsAfter).toBe(0);
  });

  it("falls back to the estimate at a call with no recorded usage", async () => {
    const metrics = await replaySession(session({}), "no-usage", stale, config, options);
    expect(metrics.sweeps).toBe(0);
    expect(metrics.peakBefore).toBe(30_000);
    const estimate = metrics.contextSumBefore - 50_000;
    expect(estimate).toBeGreaterThan(2_000);
    expect(estimate).toBeLessThan(2_100);
  });

  it("falls back to the estimate when recorded usage is zero", async () => {
    const metrics = await replaySession(session(usage(0, 0, 0)), "zero-usage", stale, config, options);
    expect(metrics.peakBefore).toBe(30_000);
    expect(metrics.contextSumBefore - 50_000).toBeLessThan(2_100);
  });
});
