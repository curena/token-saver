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
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "read" },
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "edit" },
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