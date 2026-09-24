import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, emergencyLevel } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { collectResults, handleContext } from "../src/context.js";
import type { HandleInput, PiMessage } from "../src/context.js";
import { DecisionStore } from "../src/state.js";

const WINDOW = 100_000;
const RESERVE_TOKENS = 16_384;
// 81_616: min(contextLevel 0.85, (100_000 - 16_384 - 2_000) / 100_000) * 100_000.
const EMERGENCY_BASE = emergencyLevel(WINDOW, RESERVE_TOKENS, DEFAULT_CONFIG.contextLevel) * WINDOW;
const bigText = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");

function conversation(): PiMessage[] {
  return [
    { role: "user", content: "fix the login test" },
    { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/app.ts" } }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: bigText }], isError: false },
    { role: "user", content: "now the other file" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "and now this" },
    { role: "assistant", content: [{ type: "text", text: "sure" }] },
    { role: "user", content: "keep going" },
    { role: "assistant", content: [{ type: "text", text: "will do" }] },
  ];
}

const stale: JevClient = {
  systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.01 };
    return { answers };
  },
};

function input(over: Partial<HandleInput> = {}): HandleInput {
  return {
    messages: conversation(),
    store: new DecisionStore(),
    config: { ...DEFAULT_CONFIG, minResultTokens: 100 },
    client: stale,
    usage: { tokens: 20_000, window: WINDOW },
    reserveTokens: RESERVE_TOKENS,
    arming: { turnArmAt: null, emergencyArmAt: null },
    ...over,
  };
}

/** The first context of a user turn ends with the user's message. */
function atTurnStart(messages: PiMessage[] = conversation()): PiMessage[] {
  return [...messages, { role: "user", content: "next step" }];
}

describe("collectResults", () => {
  it("pairs results with their calls and counts turns", () => {
    const collected = collectResults(conversation());
    expect(collected.results).toHaveLength(1);
    expect(collected.results[0]!.toolName).toBe("read");
    expect(collected.results[0]!.input).toEqual({ path: "src/app.ts" });
    expect(collected.currentTurn).toBe(4);
    expect(collected.results[0]!.turnsAgo).toBe(3);
    expect(collected.task.recent_user_messages).toEqual(["and now this", "keep going"]);
  });
});

describe("collectResults touches", () => {
  it("records read ranges and failed calls on touches", () => {
    const collected = collectResults([
      { role: "user", content: "go" },
      { role: "assistant", content: [
        { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts", offset: 50, limit: 10 } },
        { type: "toolCall", id: "e1", name: "edit", arguments: { path: "b.ts", oldText: "x", newText: "y" } },
        { type: "toolCall", id: "w1", name: "write", arguments: { path: "c.ts", content: "z" } },
      ] },
      { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "..." }], isError: false },
      { role: "toolResult", toolCallId: "e1", toolName: "edit", content: [{ type: "text", text: "no match" }], isError: true },
      { role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false },
    ]);
    const byPath = Object.fromEntries(collected.touches.map((touch) => [touch.path, touch]));
    expect(byPath["a.ts"]).toMatchObject({ kind: "read", offset: 50, limit: 10, isError: false });
    expect(byPath["b.ts"]).toMatchObject({ kind: "edit", isError: true });
    expect(byPath["c.ts"]).toMatchObject({ kind: "write", isError: false });
    // A failed edit changed nothing, so b.ts is not a working file.
    expect(collected.task.working_files).toEqual(["c.ts"]);
  });
});

const keepAll: JevClient = {
  systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
    return { answers };
  },
};

function withLaterTouch(call: Record<string, unknown>, isError: boolean): PiMessage[] {
  const messages = conversation();
  messages.splice(
    3,
    0,
    { role: "assistant", content: [{ type: "toolCall", id: "call_later", ...call }] },
    { role: "toolResult", toolCallId: "call_later", toolName: call.name as string, content: [{ type: "text", text: "short" }], isError },
  );
  return messages;
}

describe("handleContext supersession", () => {
  it("does not supersede an earlier read with a partial read of a different range", async () => {
    const messages = atTurnStart(withLaterTouch({ name: "read", arguments: { path: "src/app.ts", offset: 500, limit: 10 } }, false));
    const out = await handleContext(input({ messages, client: keepAll, usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.sweep!.decisions.filter((d) => d.reason === "superseded")).toEqual([]);
  });

  it("does not supersede an earlier read with a failed edit", async () => {
    const messages = atTurnStart(withLaterTouch({ name: "edit", arguments: { path: "src/app.ts", oldText: "nope", newText: "x" } }, true));
    const out = await handleContext(input({ messages, client: keepAll, usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.sweep!.decisions.filter((d) => d.reason === "superseded")).toEqual([]);
  });

  it("still supersedes an earlier read with a successful edit", async () => {
    const messages = atTurnStart(withLaterTouch({ name: "edit", arguments: { path: "src/app.ts", oldText: "a", newText: "b" } }, false));
    const out = await handleContext(input({ messages, client: keepAll, usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.sweep!.decisions.map((d) => [d.id, d.reason])).toEqual([["call_1", "superseded"]]);
  });
});

describe("handleContext", () => {
  it("does nothing without a Jev client", async () => {
    const out = await handleContext(input({ client: null }));
    expect(out.messages).toBeNull();
    expect(out.sweep).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const out = await handleContext(input({ config: { ...DEFAULT_CONFIG, enabled: false } }));
    expect(out.messages).toBeNull();
  });

  it("keeps existing stubs applied when disabled", async () => {
    const store = new DecisionStore();
    const messages = atTurnStart();
    const usage = { tokens: 80_000, window: WINDOW };
    const first = await handleContext(input({ store, messages, usage }));
    store.add(first.sweep!.decisions);
    const out = await handleContext(input({
      store, messages, usage,
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, enabled: false },
    }));
    expect(out.sweep).toBeNull();
    expect(out.trigger).toBeNull();
    expect(out.messages).not.toBeNull();
    expect(JSON.stringify(out.messages)).toContain("[token-saver]");
  });

  it("sweeps and replaces the stale result's text", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.trigger).toBe("turn");
    expect(out.sweep!.decisions).toHaveLength(1);
    const replaced = out.messages!.find((message) => message.toolCallId === "call_1")!;
    expect(JSON.stringify(replaced.content)).toContain("[token-saver]");
  });

  it("applies stored decisions without sweeping again", async () => {
    const store = new DecisionStore();
    const messages = atTurnStart();
    const usage = { tokens: 80_000, window: WINDOW };
    const first = await handleContext(input({ store, messages, usage }));
    store.add(first.sweep!.decisions);
    const second = await handleContext(input({
      store, messages, usage,
      client: { systemOne: async () => { throw new Error("should not be called"); } },
    }));
    expect(second.sweep!.reason).toBe("no-candidates");
    expect(second.trigger).toBeNull();
    expect(JSON.stringify(second.messages)).toContain("[token-saver]");
  });

  it("does not re-judge results Jev left alone within the same user turn", async () => {
    const messages = conversation();
    messages.splice(
      1,
      0,
      { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/b.ts" } }] },
      { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: bigText }], isError: false },
    );
    const judgedPaths: string[] = [];
    // Keeps everything in src/app.ts ("leave"), drops everything in src/b.ts.
    const mixed: JevClient = {
      systemOne: async (request) => {
        const path = (request.state.result as { input: { path: string } }).input.path;
        judgedPaths.push(path);
        const answers: Record<string, { noul: number }> = {};
        for (const key of Object.keys(request.questions)) answers[key] = { noul: path === "src/app.ts" ? 0.99 : 0.01 };
        return { answers };
      },
    };
    const store = new DecisionStore();
    const turnStart = atTurnStart(messages);
    const first = await handleContext(input({
      messages: turnStart, store, client: mixed, usage: { tokens: 80_000, window: WINDOW },
    }));
    expect(first.sweep!.reason).toBe("swept");
    expect(first.sweep!.decisions.map((d) => d.id)).toEqual(["call_2"]);
    expect(judgedPaths).toEqual(["src/b.ts", "src/app.ts"]);

    // A later model call in the same agent run: more tool output, no new user message.
    const later: PiMessage[] = [
      ...turnStart,
      { role: "assistant", content: [{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "call_3", toolName: "bash", content: [{ type: "text", text: "a b c" }], isError: false },
    ];
    judgedPaths.length = 0;
    // Above the 81.6% emergency level (window 100k, reserveTokens 16_384): mid-run
    // sweeps fire on the "context" trigger, not "turn".
    const second = await handleContext(input({
      messages: later, store, client: mixed, usage: { tokens: 85_000, window: WINDOW }, arming: first.arming,
    }));
    expect(judgedPaths).toEqual([]);
    expect(second.sweep?.jevRequests ?? 0).toBe(0);

    // A new user message changes the task, so the result may be judged again.
    // 82k (not 80k): `second`'s no-op "context" sweep re-arms turnArmAt, but it
    // is capped at the emergency base (81_616), not left unbounded, so 82k —
    // above that cap, below the re-armed emergency point — clears the "turn"
    // trigger directly.
    const nextTurn = atTurnStart(later);
    const third = await handleContext(input({
      messages: nextTurn, store, client: mixed, usage: { tokens: 82_000, window: WINDOW }, arming: second.arming,
    }));
    expect(judgedPaths).toEqual(["src/app.ts"]);
    expect(third.sweep!.jevRequests).toBe(1);
  });

  it("leaves the context untouched when Jev fails", async () => {
    const out = await handleContext(input({
      messages: atTurnStart(), usage: { tokens: 80_000, window: WINDOW },
      client: { systemOne: async () => { throw new Error("boom"); } },
    }));
    expect(out.messages).toBeNull();
    expect(out.sweep!.reason).toBe("judge-failed");
    expect(out.arming.turnArmAt).toBeGreaterThan(75_000); // fail-open: retry at the next trigger
  });
});

describe("handleContext triggers", () => {
  it("does not sweep mid-run below the emergency level", async () => {
    const out = await handleContext(input({ usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("mid-run");
  });

  it("does not sweep at a turn start below highWater", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 70_000, window: WINDOW } }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("below-level");
  });

  it("sweeps at a turn start at or above highWater, aiming for lowWater", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 76_000, window: WINDOW } }));
    expect(out.trigger).toBe("turn");
    expect(out.sweep?.decisions.length).toBe(1);
  });

  it("sweeps mid-run above the emergency level", async () => {
    const out = await handleContext(input({ usage: { tokens: 82_000, window: WINDOW } }));
    expect(out.trigger).toBe("context");
  });

  it("disarms the turn trigger when a sweep falls short of lowWater, capped at the emergency base", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 76_000, window: WINDOW } }));
    // One ~2k-token result can't bring 76k down to 30k, so the naive re-arm
    // point (reached + 45k) would land well above the emergency base (81_616)
    // — it's capped there instead, so a stuck turn trigger never re-arms past
    // where the emergency trigger would fire anyway.
    expect(out.arming.turnArmAt).toBe(EMERGENCY_BASE);

    const again = await handleContext(input({
      messages: atTurnStart(), usage: { tokens: 77_000, window: WINDOW }, arming: out.arming,
    }));
    expect(again.sweep).toBeNull();
    expect(again.idle).toBe("below-level");
  });

  it("caps the turn re-arm point at the emergency base, so a later turn start can still sweep", async () => {
    // Mid-run, above the emergency base, with nothing eligible enough to reach
    // the target: the "context" trigger fires but falls short.
    const out = await handleContext(input({ usage: { tokens: 85_000, window: WINDOW } }));
    expect(out.trigger).toBe("context");
    expect(out.arming.turnArmAt).toBeLessThanOrEqual(EMERGENCY_BASE);

    // A turn start above that (capped) turnArmAt, but below the re-armed
    // emergencyArmAt, still sweeps via the turn trigger — it isn't stranded
    // behind an unreachably high re-arm point.
    const again = await handleContext(input({
      messages: atTurnStart(), usage: { tokens: 82_000, window: WINDOW }, arming: out.arming,
    }));
    expect(again.trigger).toBe("turn");
  });

  it("resets arming to the base level on a no-usage call", async () => {
    const out = await handleContext(input({
      usage: null, arming: { turnArmAt: 90_000, emergencyArmAt: 95_000 },
    }));
    expect(out.idle).toBe("no-usage");
    expect(out.arming).toEqual({ turnArmAt: null, emergencyArmAt: null });
  });

  it("resets arming once the context has shrunk back to (or below) the target", async () => {
    // e.g. right after pi compacted: usage is back down near lowWater, so
    // arm points raised before that no longer apply.
    const out = await handleContext(input({
      usage: { tokens: 30_000, window: WINDOW }, // === lowWater * window
      arming: { turnArmAt: 90_000, emergencyArmAt: 95_000 },
    }));
    expect(out.arming).toEqual({ turnArmAt: null, emergencyArmAt: null });
  });

  it("does not sweep when usage is unknown", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: null }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("no-usage");
  });
});
