import { describe, expect, it } from "vitest";
import { selectEligible } from "../src/policy/eligibility.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";

function ref(over: Partial<ResultRef> = {}): ResultRef {
  return {
    id: "call_1",
    toolName: "read",
    input: { path: "src/app.ts" },
    text: "x".repeat(40_000),
    tokens: 10_000,
    messageIndex: 4,
    turnsAgo: 5,
    isError: false,
    ...over,
  };
}

const none = new Map<string, Decision>();

describe("selectEligible", () => {
  it("accepts a large, old, undecided result", () => {
    expect(selectEligible([ref()], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("protects results from the last protectTurns turns", () => {
    expect(selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ turnsAgo: 3 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("honours a relaxed minTurnsAgo for the context-limit trigger", () => {
    const relaxed = selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG, {
      minTurnsAgo: 1,
    });
    expect(relaxed).toHaveLength(1);
  });

  it("skips results under minResultTokens but keeps the threshold itself", () => {
    expect(selectEligible([ref({ tokens: 1499 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ tokens: 1500 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("skips errors", () => {
    expect(selectEligible([ref({ isError: true })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips excluded tools", () => {
    expect(selectEligible([ref({ toolName: "edit" })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "write" })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips results that already have a decision", () => {
    const decided = new Map<string, Decision>([
      ["call_1", {
        id: "call_1", level: "stub", rendered: "[token-saver] ...",
        savedTokens: 9000, reason: "judged", keptChunks: [], decidedAtTurn: 3,
      }],
    ]);
    expect(selectEligible([ref()], decided, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips recall output from the protected window but not older recalls", () => {
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 9 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });
});

describe("selectEligible and the secrets denylist", () => {
  // The other half of "redact locally, then send": a denylisted file is not sent at all,
  // redacted or otherwise. The cost is the saving on that one result.
  const decided = new Map<string, Decision>();

  function big(input: Record<string, unknown>): ResultRef {
    return {
      id: "call_1", toolName: "read", input,
      text: "x", tokens: 9000, messageIndex: 1, turnsAgo: 5, isError: false,
    };
  }

  it("leaves a result alone when its input names a denylisted path", () => {
    for (const input of [
      { path: ".env" },
      { path: ".env.production" },
      { path: "/home/me/project/.envrc" },
      { path: "certs/server.pem" },
      { path: "/home/me/.ssh/id_ed25519" },
      { path: "secrets/prod.json" },
      { command: "cat .env" },
      { command: "grep -r TOKEN secrets/" },
      { paths: ["src/app.ts", "deploy/secrets/keys.json"] },
      { nested: { file: { path: "config/.env.local" } } },
    ]) {
      expect(selectEligible([big(input)], decided, DEFAULT_CONFIG)).toEqual([]);
    }
  });

  it("still sweeps an ordinary path that merely mentions the words", () => {
    for (const input of [
      { path: "src/environment.ts" },
      { path: "docs/secrets-policy.md" },
      { path: "src/identity.ts" },
      { command: "npm run build" },
    ]) {
      expect(selectEligible([big(input)], decided, DEFAULT_CONFIG)).toHaveLength(1);
    }
  });

  it("does not walk an input deep enough to be a denial of service", () => {
    // Nested past the bound, so the secret is missed -- deliberately. A harness that
    // produced this shape would be the bug; an unbounded walk here would be ours.
    let input: Record<string, unknown> = { path: ".env" };
    for (let i = 0; i < 8; i++) input = { wrap: input };
    expect(selectEligible([big(input)], decided, DEFAULT_CONFIG)).toHaveLength(1);
  });
});
