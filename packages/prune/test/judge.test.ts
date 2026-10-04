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

  it("reads a malformed probability as keep, not as drop", async () => {
    for (const bad of [Number.NaN, -1, 1.5, "0.9", null]) {
      const client: JevClient = {
        systemOne: async () => ({ answers: { "chunk::0": { noul: bad as number }, "chunk::1": { noul: 0.1 } } }),
      };
      const out = await judgeResult(client, buildRequest(result, chunks, task, "", DEFAULT_CONFIG), 2, DEFAULT_CONFIG);
      expect(out).toEqual([1, 0.1]);
    }
  });
});

/**
 * The requirement this covers: redact locally, then send. The pruner's state is tool-result
 * text -- file contents, command output -- so it is the half of the product the requirement
 * was written for. It gets redaction by routing through core's `Jev`, not by its own pass.
 */
describe("judgeResult redaction", () => {
  const SECRET_KEY = "sk-livekey1234567890abcdefgh";
  const SECRET_ASSIGNMENT = "OPENAI_API_KEY=hunter2hunter2";

  function capturing(): { requests: any[]; client: JevClient } {
    const requests: any[] = [];
    return {
      requests,
      client: {
        systemOne: async (request: any) => {
          requests.push(request);
          return { answers: { "chunk::0": { noul: 0.1 }, "chunk::1": { noul: 0.1 } } };
        },
      },
    };
  }

  const leaky: Chunk[] = [
    { index: 0, startLine: 1, endLine: 2, text: `const key = "${SECRET_KEY}";`, tokens: 500 },
    { index: 1, startLine: 3, endLine: 4, text: SECRET_ASSIGNMENT, tokens: 500 },
  ];

  it("masks a secret in chunk text before the client sees it", async () => {
    const { requests, client } = capturing();
    const request = buildRequest(result, leaky, task, "", DEFAULT_CONFIG);
    await judgeResult(client, request, 2, DEFAULT_CONFIG);
    const sent = JSON.stringify(requests[0]);
    expect(sent).not.toContain(SECRET_KEY);
    expect(sent).not.toContain("hunter2hunter2");
    expect(sent).toContain("[REDACTED]");
  });

  it("masks a secret in the surrounding task state too", async () => {
    const { requests, client } = capturing();
    const leakyTask: TaskState = { ...task, latest_assistant_text: `exported ${SECRET_KEY}` };
    await judgeResult(client, buildRequest(result, chunks, leakyTask, "", DEFAULT_CONFIG), 2, DEFAULT_CONFIG);
    expect(JSON.stringify(requests[0])).not.toContain(SECRET_KEY);
  });

  it("leaves the caller's request untouched, so recall restores the original lines", async () => {
    const { client } = capturing();
    const request = buildRequest(result, leaky, task, "", DEFAULT_CONFIG);
    await judgeResult(client, request, 2, DEFAULT_CONFIG);
    // The masked copy exists only for the duration of the call. Everything the agent is
    // ever shown -- a rendered stub, a recalled range -- comes from this side.
    expect(JSON.stringify(request.state)).toContain(SECRET_KEY);
    expect(leaky[0]!.text).toContain(SECRET_KEY);
  });

  it("sends the questions verbatim, because they carry nothing to redact", async () => {
    // `Jev.ask` redacts `state` and deliberately not `questions`. That is safe here only
    // because `instructionsFor` interpolates a chunk index and nothing else; this asserts
    // the questions survive the trip unchanged, so a future builder that starts
    // interpolating session text fails here rather than leaking quietly.
    const { requests, client } = capturing();
    const request = buildRequest(result, leaky, task, "", DEFAULT_CONFIG);
    await judgeResult(client, request, 2, DEFAULT_CONFIG);
    expect(requests[0].questions).toEqual(request.questions);
    expect(JSON.stringify(request.questions)).not.toContain("[REDACTED]");
  });

  it("pins the model on the request that actually goes out", async () => {
    const { requests, client } = capturing();
    await judgeResult(client, buildRequest(result, chunks, task, "", DEFAULT_CONFIG), 2, DEFAULT_CONFIG);
    expect(requests[0].model).toBe("jev-1.13.0");
  });
});
