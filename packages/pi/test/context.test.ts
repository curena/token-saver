import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { collectResults, handleContext } from "../src/context.js";
import type { HandleInput, PiMessage } from "../src/context.js";
import { DecisionStore } from "../src/state.js";

const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
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
    prices: PRICES,
    contextFraction: 0.2,
    callsSoFar: 20,
    lastForcedFraction: null,
    lastForcedEligible: null,
    cooldownUntilTurn: 0,
    ...over,
  };
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

  it("sweeps and replaces the stale result's text", async () => {
    const out = await handleContext(input());
    expect(out.trigger).toBe("cost");
    expect(out.sweep!.decisions).toHaveLength(1);
    const replaced = out.messages!.find((message) => message.toolCallId === "call_1")!;
    expect(JSON.stringify(replaced.content)).toContain("[token-saver]");
  });

  it("applies stored decisions without sweeping again", async () => {
    const store = new DecisionStore();
    const first = await handleContext(input({ store }));
    store.add(first.sweep!.decisions);
    const second = await handleContext(input({ store, client: { systemOne: async () => { throw new Error("should not be called"); } } }));
    expect(second.sweep!.reason).toBe("no-candidates");
    expect(second.trigger).toBeNull();
    expect(JSON.stringify(second.messages)).toContain("[token-saver]");
  });

  it("forces a sweep when context usage crosses the level", async () => {
    const out = await handleContext(input({
      contextFraction: 0.7,
      // a cost gate this strict would refuse on its own
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBe("context");
    expect(out.lastForcedFraction).toBe(0.7);
    expect(out.lastForcedEligible).toBe(1);
  });

  it("does not force again until usage grows by ten points", async () => {
    const out = await handleContext(input({
      contextFraction: 0.65, lastForcedFraction: 0.6, lastForcedEligible: 1,
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBeNull();
  });

  it("forces again when new results become eligible", async () => {
    const messages = conversation();
    messages.splice(
      3,
      0,
      { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/b.ts" } }] },
      { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: bigText }], isError: false },
    );
    const out = await handleContext(input({
      messages, contextFraction: 0.65, lastForcedFraction: 0.6, lastForcedEligible: 1,
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBe("context");
    expect(out.lastForcedEligible).toBe(2);
  });

  it("respects the cooldown after a refused post-gate", async () => {
    const keepAll: JevClient = {
      systemOne: async (request) => {
        const answers: Record<string, { noul: number }> = {};
        for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
        return { answers };
      },
    };
    const first = await handleContext(input({ client: keepAll }));
    expect(first.sweep!.reason).toBe("post-gate");
    expect(first.cooldownUntilTurn).toBe(7);

    const second = await handleContext(input({
      client: { systemOne: async () => { throw new Error("should not be called"); } },
      cooldownUntilTurn: 7,
    }));
    expect(second.sweep).toBeNull();
  });

  it("leaves the context untouched when Jev fails", async () => {
    const out = await handleContext(input({
      client: { systemOne: async () => { throw new Error("boom"); } },
    }));
    expect(out.messages).toBeNull();
    expect(out.sweep!.reason).toBe("judge-failed");
    expect(out.cooldownUntilTurn).toBe(0);   // fail-open: retry at the next trigger
  });
});