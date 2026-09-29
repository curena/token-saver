import { describe, expect, it } from "vitest";
import { chunkResult } from "../src/chunk.js";

const line = (n: number) => `line ${n}`;

describe("chunkResult", () => {
  it("covers every line exactly once, in order", () => {
    const text = Array.from({ length: 250 }, (_, i) => line(i + 1)).join("\n");
    const chunks = chunkResult("bash", text);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(250);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
      expect(chunks[i]!.index).toBe(i);
    }
    expect(chunks.map((c) => c.text).join("\n")).toBe(text);
  });

  it("offsets line numbers when a read started partway through a file", () => {
    const text = Array.from({ length: 30 }, (_, i) => line(i)).join("\n");
    const chunks = chunkResult("read", text, 101);
    expect(chunks[0]!.startLine).toBe(101);
    expect(chunks.at(-1)!.endLine).toBe(130);
  });

  it("splits a read at top-level declarations", () => {
    const body = (name: string) =>
      [
        `export function ${name}() {`,
        ...Array.from({ length: 9 }, (_, i) => `  const step${i} = ${i};`),
        "  return 0;",
        "}",
      ].join("\n");
    const text = [body("alpha"), body("beta"), body("gamma")].join("\n");
    const chunks = chunkResult("read", text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]!.text.startsWith("export function ")).toBe(true);
  });

  it("splits bash output at blank lines", () => {
    const block = (n: number) => Array.from({ length: 25 }, (_, i) => `${n}:${i}`).join("\n");
    const text = `${block(1)}\n\n${block(2)}`;
    const chunks = chunkResult("bash", text);
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.text.startsWith("2:0")).toBe(true);
  });

  it("keeps a run of blank lines at the tail of the chunk it closes", () => {
    const block = (n: number) => Array.from({ length: 25 }, (_, i) => `${n}:${i}`).join("\n");
    const text = `${block(1)}\n\n\n\n${block(2)}`;
    const chunks = chunkResult("bash", text);
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.text.startsWith("2:0")).toBe(true);
    expect(chunks.map((c) => c.text).join("\n")).toBe(text);
  });

  it("keeps chunks within the per-tool maximum", () => {
    const text = Array.from({ length: 500 }, (_, i) => line(i)).join("\n");
    for (const [tool, max] of [["read", 60], ["bash", 40], ["other", 40]] as const) {
      for (const chunk of chunkResult(tool, text)) {
        expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(max);
      }
    }
  });

  it("returns a single chunk for short text", () => {
    expect(chunkResult("bash", "one\ntwo")).toHaveLength(1);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkResult("bash", "")).toEqual([]);
  });
});
