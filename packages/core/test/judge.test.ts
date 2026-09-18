import { describe, expect, it, vi } from "vitest";
import { buildRequest, judgeResult } from "../src/judge.js";
import type { JevClient, TaskState } from "../src/judge.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Chunk, ResultRef } from "../src/types.js";

const result: ResultRef = {
  id: "call_83", toolName: "read", input: { path: "src/app.ts" },
  text: "", tokens: 9000, messageIndex: 4, turnsAgo: 5, isError: false,
};
const chunks: Chunk[] = [
  { index: 0, startLine: 1, endLine: 20, text: "alpha", tokens: 500 },
  { index: 1, startLine: 21, endLine: 40, text: "beta", tokens: 500 },
];
const task: TaskState = {
  recent_user_messages: ["fix the failing login test"],
  latest_assistant_text: "I'll look at the auth handler",
  working_files: ["src/auth.ts"],
};

describe("buildRequest", () => {
  const request = buildRequest(result, chunks, task, "agent then edited src/auth.ts", DEFAULT_CONFIG);

  it("pins the configured model", () => {
    expect(request.model).toBe("jev-1.13.0");
  });

  it("puts the task, the result, what came after, and the chunks in state", () => {
    expect(request.state).toMatchObject({
      task,
      result: { tool: "read", input: { path: "src/app.ts" } },
      after_result: "agent then edited src/auth.ts",
    });
    expect((request.state.chunks as unknown[]).length).toBe(2);
  });

  it("asks one noul per chunk, keyed by index and referencing that chunk's path", () => {
    expect(Object.keys(request.questions)).toEqual(["chunk::0", "chunk::1"]);
    const first = request.questions["chunk::0"] as { type: string; instructions: string };
    expect(first.type).toBe("noul");
    expect(first.instructions).toContain("`chunks[0]`");
  });

  it("does not send chunk text twice", () => {
    const serialized = JSON.stringify(request.questions);
    expect(serialized).not.toContain("alpha");
  });
});

describe("judgeResult", () => {
  const request = buildRequest(result, chunks, task, "", DEFAULT_CONFIG);

  it("returns one probability per chunk, in index order", async () => {
    const client: JevClient = {
      systemOne: async () => ({ answers: { "chunk::1": { noul: 0.8 }, "chunk::0": { noul: 0.1 } } }),
    };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toEqual([0.1, 0.8]);
  });

  it("keeps a chunk whose answer is missing", async () => {
    const client: JevClient = {
      systemOne: async () => ({ answers: { "chunk::0": { noul: 0.1 } } }),
    };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toEqual([0.1, 1]);
  });

  it("returns null when the client throws", async () => {
    const client: JevClient = { systemOne: async () => { throw new Error("429"); } };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toBeNull();
  });

  it("returns null when the client exceeds the budget", async () => {
    vi.useFakeTimers();
    const client: JevClient = { systemOne: () => new Promise(() => {}) };
    const pending = judgeResult(client, request, 2, { ...DEFAULT_CONFIG, jevBudgetMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeNull();
    vi.useRealTimers();
  });

  it("returns null when the caller's signal is already aborted", async () => {
    const client: JevClient = { systemOne: async () => ({ answers: {} }) };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG, AbortSignal.abort())).toBeNull();
  });
});
