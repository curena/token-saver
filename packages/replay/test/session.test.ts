import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { afterResultSummary, parseSession } from "../src/session.js";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");

describe("parseSession", () => {
  const sites = parseSession(jsonl);

  it("makes one call site per assistant message", () => {
    expect(sites).toHaveLength(3);
  });

  it("carries the tool results available before each call", () => {
    expect(sites[0]!.results).toHaveLength(0);
    expect(sites[1]!.results.map((r) => r.id)).toEqual(["call_1"]);
    expect(sites[2]!.results.map((r) => r.id)).toEqual(["call_1", "call_2"]);
  });

  it("joins text blocks and estimates tokens for a result", () => {
    const result = sites[1]!.results[0]!;
    expect(result.text).toContain("export function login");
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.toolName).toBe("read");
    expect(result.input).toEqual({ path: "src/auth.ts" });
  });

  it("counts user turns and turnsAgo", () => {
    expect(sites[1]!.userTurn).toBe(1);
    expect(sites[2]!.userTurn).toBe(2);
    expect(sites[2]!.results[0]!.turnsAgo).toBe(1);
  });

  it("records file touches from read, edit and write calls", () => {
    expect(sites[2]!.touches).toEqual([
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "read", isError: false },
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "edit", isError: false },
    ]);
  });

  it("collects task state for the judgment", () => {
    expect(sites[2]!.recentUserMessages).toEqual(["fix the login test", "now run the tests"]);
    expect(sites[2]!.latestAssistantText).toBe("Now editing");
    expect(sites[2]!.workingFiles).toContain("src/auth.ts");
  });

  it("keeps the model and usage of each call", () => {
    expect(sites[2]!.model).toBe("claude-sonnet-5");
    expect(sites[2]!.usage.cacheRead).toBe(2000);
  });

  it("tracks token counts for every message, not just results", () => {
    const site = sites[2]!;
    // Three message kinds contribute: user text, assistant text and tool results.
    const allMessages = site.tokenCounts.reduce((sum, tokens) => sum + tokens, 0);
    const resultsOnly = site.results.reduce((sum, result) => sum + result.tokens, 0);
    expect(site.tokenCounts.length).toBeGreaterThan(site.results.length);
    expect(allMessages).toBeGreaterThan(resultsOnly);
  });
});

describe("afterResultSummary", () => {
  it("describes what the agent did after the result", () => {
    const sites = parseSession(jsonl);
    const summary = afterResultSummary(sites[2]!, sites[2]!.results[0]!);
    expect(summary).toContain("edit");
    expect(summary).toContain("src/auth.ts");
  });

  it("is empty when nothing followed", () => {
    const sites = parseSession(jsonl);
    expect(afterResultSummary(sites[1]!, sites[1]!.results[0]!)).toBe("");
  });
});
function line(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "message", id: `e${Math.random()}`, message: { role, content, ...extra } });
}

describe("parseSession token accounting and task state", () => {
  const bigArgs = { path: "src/new.ts", content: "x".repeat(800) };
  const session = [
    line("user", "write the file"),
    line("assistant", [
      { type: "text", text: "Plan A" },
      { type: "toolCall", id: "c1", name: "write", arguments: bigArgs },
    ]),
    line("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "c1", toolName: "write" }),
    line("assistant", [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }]),
    line("toolResult", [{ type: "text", text: "new.ts" }], { toolCallId: "c2", toolName: "bash" }),
    line("assistant", [{ type: "text", text: "Done" }]),
  ].join("\n");
  const sites = parseSession(session);

  it("counts assistant tool-call arguments in message tokens", () => {
    // messageIndex 2 is the assistant message carrying the large write call.
    expect(sites[1]!.tokenCounts[2]).toBeGreaterThanOrEqual(JSON.stringify(bigArgs).length / 4);
  });

  it("does not include the call's own output in its context", () => {
    for (const site of sites) {
      expect(site.tokenCounts).toHaveLength(site.entryIndex);
      expect(site.tokenCounts[site.entryIndex]).toBeUndefined();
    }
    // The first call's context is just the user message.
    expect(sites[0]!.tokenCounts.reduce((a, b) => a + b, 0)).toBe(Math.ceil("write the file".length / 4));
  });

  it("keeps the previous assistant text across tool-call-only messages", () => {
    expect(sites[2]!.latestAssistantText).toBe("Plan A");
  });
});

describe("parseSession touch details", () => {
  const session = [
    line("user", "look"),
    line("assistant", [
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts", offset: 10, limit: 20 } },
      { type: "toolCall", id: "e1", name: "edit", arguments: { path: "b.ts" } },
      { type: "toolCall", id: "w1", name: "write", arguments: { path: "c.ts" } },
    ]),
    line("toolResult", [{ type: "text", text: "lines" }], { toolCallId: "r1", toolName: "read" }),
    line("toolResult", [{ type: "text", text: "no match" }], { toolCallId: "e1", toolName: "edit", isError: true }),
    line("assistant", [{ type: "text", text: "between" }]),
    line("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "w1", toolName: "write" }),
    line("assistant", [{ type: "text", text: "done" }]),
  ].join("\n");
  const sites = parseSession(session);

  it("copies offset and limit onto read touches and marks failed calls", () => {
    expect(sites[1]!.touches).toEqual([
      { path: "a.ts", messageIndex: 2, kind: "read", offset: 10, limit: 20, isError: false },
      { path: "b.ts", messageIndex: 2, kind: "edit", isError: true },
      { path: "c.ts", messageIndex: 2, kind: "write" },
    ]);
  });

  it("does not rewrite touches already recorded at an earlier call site", () => {
    expect(sites[1]!.touches[2]!.isError).toBeUndefined();
    expect(sites[2]!.touches[2]!.isError).toBe(false);
  });

  it("leaves failed edits and writes out of working files", () => {
    expect(sites[1]!.workingFiles).toEqual(["c.ts"]);
  });
});
