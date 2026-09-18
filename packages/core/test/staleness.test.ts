import { describe, expect, it } from "vitest";
import { findSuperseded, normalizePath, pathOf } from "../src/policy/staleness.js";
import type { ResultRef } from "../src/types.js";

function read(id: string, path: string, messageIndex: number): ResultRef {
  return {
    id, toolName: "read", input: { path }, text: "body",
    tokens: 5000, messageIndex, turnsAgo: 4, isError: false,
  };
}

describe("normalizePath", () => {
  it("settles spellings that do not need a working directory", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath(".//src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src//a.ts")).toBe("src/a.ts");
    expect(normalizePath("src/dir/")).toBe("src/dir");
    expect(normalizePath("/")).toBe("/");
  });

  it("leaves case and absolute paths alone", () => {
    expect(normalizePath("src/App.ts")).toBe("src/App.ts");
    expect(normalizePath("/abs/src/a.ts")).toBe("/abs/src/a.ts");
  });
});

describe("pathOf", () => {
  it("normalises the path it returns", () => {
    expect(pathOf(read("a", "./src/app.ts", 1))).toBe("src/app.ts");
  });

  it("reads input.path", () => {
    expect(pathOf(read("a", "src/app.ts", 1))).toBe("src/app.ts");
  });

  it("falls back to input.file_path", () => {
    const result = { ...read("a", "x", 1), input: { file_path: "src/b.ts" } };
    expect(pathOf(result)).toBe("src/b.ts");
  });

  it("returns null when there is no path", () => {
    const result = { ...read("a", "x", 1), toolName: "bash", input: { command: "ls" } };
    expect(pathOf(result)).toBeNull();
  });
});

describe("findSuperseded", () => {
  it("matches paths that differ only in spelling", () => {
    const superseded = findSuperseded(
      [read("a", "src/app.ts", 2)],
      [{ path: "./src/app.ts", messageIndex: 5, kind: "edit" }],
    );
    expect([...superseded]).toEqual(["a"]);
  });


  it("marks a read whose file was edited afterwards", () => {
    const found = findSuperseded([read("a", "src/app.ts", 2)], [
      { path: "src/app.ts", messageIndex: 6, kind: "edit" },
    ]);
    expect([...found]).toEqual(["a"]);
  });

  it("marks a read whose file was read again afterwards", () => {
    const found = findSuperseded([read("a", "src/app.ts", 2)], [
      { path: "src/app.ts", messageIndex: 8, kind: "read" },
    ]);
    expect([...found]).toEqual(["a"]);
  });

  it("ignores touches that came before the read", () => {
    const found = findSuperseded([read("a", "src/app.ts", 9)], [
      { path: "src/app.ts", messageIndex: 3, kind: "edit" },
    ]);
    expect(found.size).toBe(0);
  });

  it("ignores touches to other files", () => {
    const found = findSuperseded([read("a", "src/app.ts", 2)], [
      { path: "src/other.ts", messageIndex: 7, kind: "edit" },
    ]);
    expect(found.size).toBe(0);
  });

  it("never marks non-read results", () => {
    const bash: ResultRef = {
      id: "b", toolName: "bash", input: { command: "cat src/app.ts" }, text: "out",
      tokens: 5000, messageIndex: 2, turnsAgo: 4, isError: false,
    };
    expect(findSuperseded([bash], [{ path: "src/app.ts", messageIndex: 5, kind: "edit" }]).size).toBe(0);
  });
});
