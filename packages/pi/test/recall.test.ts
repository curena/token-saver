import { describe, expect, it } from "vitest";
import { recall, sessionSource } from "../src/recall.js";

const entries = [
  { type: "message", message: { role: "user", content: "hello" } },
  {
    type: "message",
    message: {
      role: "toolResult", toolCallId: "call_83",
      content: [{ type: "text", text: "alpha\nbeta\ngamma\ndelta" }],
    },
  },
];

describe("sessionSource", () => {
  it("finds a result's text by tool call id", () => {
    expect(sessionSource(entries).findResultText("call_83")).toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("returns null for an unknown id", () => {
    expect(sessionSource(entries).findResultText("nope")).toBeNull();
  });
});

describe("recall", () => {
  const source = sessionSource(entries);

  it("returns the whole text by default", () => {
    const result = recall(source, { id: "call_83" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("returns an inclusive line range", () => {
    expect(recall(source, { id: "call_83", startLine: 2, endLine: 3 }).content[0].text).toBe("beta\ngamma");
  });

  it("clamps out-of-range line numbers", () => {
    expect(recall(source, { id: "call_83", startLine: 0, endLine: 99 }).content[0].text)
      .toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("reports an unknown id as an error result, naming the id", () => {
    const result = recall(source, { id: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
  });
});

describe("recall of a read with an offset", () => {
  // `read a.ts offset=200` returns file lines 200.. as result lines 1..; the
  // sweep's "… lines N–M elided …" markers use real file line numbers.
  const offsetEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "a.ts", offset: 200 } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult", toolCallId: "call_read",
        content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `line ${200 + i}`).join("\n") }],
      },
    },
  ];
  const source = sessionSource(offsetEntries);

  it("interprets startLine/endLine as real file lines, matching the elided markers", () => {
    expect(recall(source, { id: "call_read", startLine: 203, endLine: 205 }).content[0].text)
      .toBe("line 203\nline 204\nline 205");
  });

  it("clamps file-line ranges to the lines the result holds", () => {
    expect(recall(source, { id: "call_read", startLine: 1, endLine: 201 }).content[0].text)
      .toBe("line 200\nline 201");
    expect(recall(source, { id: "call_read", startLine: 208, endLine: 999 }).content[0].text)
      .toBe("line 208\nline 209");
  });
});
