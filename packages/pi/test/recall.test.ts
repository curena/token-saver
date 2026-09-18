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