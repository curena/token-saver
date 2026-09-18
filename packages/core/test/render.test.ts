import { describe, expect, it } from "vitest";
import { describeResult, renderPartial, renderStub } from "../src/render.js";
import type { Chunk, ResultRef } from "../src/types.js";

const result: ResultRef = {
  id: "call_83", toolName: "read", input: { path: "src/app.ts" },
  text: "", tokens: 9800, messageIndex: 4, turnsAgo: 5, isError: false,
};

function chunk(index: number, startLine: number, lines: string[]): Chunk {
  return {
    index, startLine, endLine: startLine + lines.length - 1,
    text: lines.join("\n"), tokens: lines.length * 4,
  };
}

describe("describeResult", () => {
  it("names the file for a read", () => {
    expect(describeResult(result)).toBe("read src/app.ts");
  });

  it("shows a truncated command for bash", () => {
    const bash = { ...result, toolName: "bash", input: { command: "npm test -- --runInBand extra long tail here" } };
    expect(describeResult(bash)).toMatch(/^bash: npm test/);
    expect(describeResult(bash).length).toBeLessThanOrEqual(60);
  });

  it("falls back to the tool name", () => {
    expect(describeResult({ ...result, toolName: "grep", input: {} })).toBe("grep");
  });
});

describe("renderStub", () => {
  it("states what was removed and how to get it back", () => {
    const text = renderStub(result, 412);
    expect(text).toContain("[token-saver]");
    expect(text).toContain("read src/app.ts");
    expect(text).toContain("412 lines");
    expect(text).toContain('recall({id:"call_83"})');
    expect(text.split("\n")).toHaveLength(1);
  });
});

describe("renderPartial", () => {
  const chunks = [
    chunk(0, 1, ["alpha", "beta"]),
    chunk(1, 3, ["gamma", "delta"]),
    chunk(2, 5, ["epsilon"]),
  ];

  it("keeps chosen chunks verbatim with real line numbers", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).toContain("   1| alpha");
    expect(text).toContain("   2| beta");
    expect(text).toContain("   5| epsilon");
  });

  it("marks each gap with its line range and the recall id", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).toContain("… lines 3–4 elided …");
    expect(text).toContain('recall({id:"call_83"');
  });

  it("does not leak elided text", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).not.toContain("gamma");
    expect(text).not.toContain("delta");
  });

  it("emits kept chunks in line order regardless of the kept list order", () => {
    const text = renderPartial(result, chunks, [2, 0]);
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("epsilon"));
  });
});
