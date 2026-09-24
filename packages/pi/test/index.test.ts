import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Decision } from "@token-saver/core";
import { RESTORE_ENTRY, SWEEP_ENTRY } from "../src/state.js";

function decision(id: string): Decision {
  return { id, level: "stub", rendered: `[token-saver] ${id}`, savedTokens: 1000, reason: "judged", keptChunks: [], decidedAtTurn: 1 };
}

type Entry = { type: string; customType?: string; data?: unknown };

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: Entry[] = [
    { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("a")], trigger: "cost", at: "t" } },
  ];
  const pi = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerEntryRenderer: () => {},
    registerTool: () => {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
  };
  const ctx = {
    sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
    ui: { notify: vi.fn() },
    getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
  };
  const messages = [
    { role: "user", content: "go" },
    { role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "full output" }] },
  ];
  const context = () => handlers.get("context")!({ messages }, ctx);
  return { pi, ctx, entries, handlers, commands, context };
}

describe("/token-saver restore", () => {
  let extension: (pi: any) => void;
  beforeAll(async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    extension = (await import("../src/index.js")).default;
  });

  it("persists the restore so a reload does not shorten the result again", async () => {
    const h = harness();
    extension(h.pi);
    await h.handlers.get("session_start")!({}, h.ctx);
    expect((await h.context())?.messages[1].content[0].text).toBe("[token-saver] a");

    await h.commands.get("token-saver")!.handler("restore a", h.ctx);
    expect(h.pi.appendEntry).toHaveBeenCalledWith(RESTORE_ENTRY, { id: "a" });
    expect(await h.context()).toBeUndefined();

    // Reload: the sweep entry is still in the session, but the restore wins.
    await h.handlers.get("session_tree")!({}, h.ctx);
    expect(await h.context()).toBeUndefined();
    await h.handlers.get("session_start")!({}, h.ctx);
    expect(await h.context()).toBeUndefined();
  });

  it("does not append an entry for an id with nothing to restore", async () => {
    const h = harness();
    extension(h.pi);
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.commands.get("token-saver")!.handler("restore nope", h.ctx);
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("token-saver has no decision for nope", "info");
  });
});
