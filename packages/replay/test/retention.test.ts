import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectLaterUses, detectMisses } from "../src/retention.js";
import type { Chunk } from "@token-saver/prune";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");

function chunk(index: number, lines: string[]): Chunk {
  return { index, startLine: index * 10 + 1, endLine: index * 10 + lines.length, text: lines.join("\n"), tokens: 40 };
}

describe("collectLaterUses", () => {
  it("collects assistant text and tool arguments after a point", () => {
    const uses = collectLaterUses(jsonl, 3);
    expect(uses.some((use) => use.kind === "assistant" && use.text.includes("Now editing"))).toBe(true);
    expect(uses.some((use) => use.text.includes("src/auth.ts"))).toBe(true);
  });

  it("returns nothing for a point past the end", () => {
    expect(collectLaterUses(jsonl, 999)).toEqual([]);
  });
});

describe("detectMisses", () => {
  const chunks = [
    chunk(0, ["export function login(credentials) {", "  return session.create(credentials);"]),
    chunk(1, ["const unrelatedHelper = 42;"]),
  ];

  it("reports an elided chunk whose line the agent later used", () => {
    const misses = detectMisses("call_1", chunks, [0.1, 0.05], [0, 1], [
      { text: "return session.create(credentials); is wrong here", kind: "assistant" },
    ]);
    expect(misses).toEqual([{ resultId: "call_1", chunkIndex: 0, probability: 0.1, evidence: "assistant" }]);
  });

  it("ignores chunks that were kept", () => {
    const misses = detectMisses("call_1", chunks, [0.9, 0.05], [1], [
      { text: "return session.create(credentials);", kind: "assistant" },
    ]);
    expect(misses).toEqual([]);
  });

  it("ignores short lines that would match by accident", () => {
    const short = [chunk(0, ["}", "x = 1"])];
    const misses = detectMisses("call_1", short, [0.01], [0], [{ text: "}", kind: "assistant" }]);
    expect(misses).toEqual([]);
  });

  it("matches edits and commands too", () => {
    const misses = detectMisses("call_1", chunks, [0.01, 0.01], [0, 1], [
      { text: "const unrelatedHelper = 42;", kind: "edit" },
    ]);
    expect(misses.map((miss) => miss.evidence)).toEqual(["edit"]);
  });
});