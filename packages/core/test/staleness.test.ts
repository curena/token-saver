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

  describe("partial reads", () => {
    function rangedRead(id: string, messageIndex: number, range: Record<string, unknown>): ResultRef {
      return { ...read(id, "a.ts", messageIndex), input: { path: "a.ts", ...range } };
    }

    it("does not supersede a read with a later read of a different range", () => {
      const found = findSuperseded([rangedRead("a", 2, { limit: 200 })], [
        { path: "a.ts", messageIndex: 8, kind: "read", offset: 800, limit: 50 },
      ]);
      expect(found.size).toBe(0);
    });

    it("does not supersede when the later read only partly overlaps", () => {
      const found = findSuperseded([rangedRead("a", 2, { offset: 100, limit: 100 })], [
        { path: "a.ts", messageIndex: 8, kind: "read", offset: 150, limit: 100 },
      ]);
      expect(found.size).toBe(0);
    });

    it("supersedes when the later read covers the earlier range", () => {
      const found = findSuperseded([rangedRead("a", 2, { offset: 100, limit: 50 })], [
        { path: "a.ts", messageIndex: 8, kind: "read", offset: 50, limit: 200 },
      ]);
      expect([...found]).toEqual(["a"]);
    });

    it("a full-file read covers any earlier partial read", () => {
      const found = findSuperseded([rangedRead("a", 2, { offset: 800, limit: 50 })], [
        { path: "a.ts", messageIndex: 8, kind: "read" },
      ]);
      expect([...found]).toEqual(["a"]);
    });

    it("a partial read does not cover an earlier full-file read", () => {
      const found = findSuperseded([read("a", "a.ts", 2)], [
        { path: "a.ts", messageIndex: 8, kind: "read", offset: 1, limit: 50 },
      ]);
      expect(found.size).toBe(0);
    });

    it("an open-ended later read covers an earlier range after its offset", () => {
      const found = findSuperseded([rangedRead("a", 2, { offset: 300, limit: 20 })], [
        { path: "a.ts", messageIndex: 8, kind: "read", offset: 200 },
      ]);
      expect([...found]).toEqual(["a"]);
    });

    it("a successful edit still supersedes a partial read", () => {
      const found = findSuperseded([rangedRead("a", 2, { limit: 200 })], [
        { path: "a.ts", messageIndex: 8, kind: "edit" },
      ]);
      expect([...found]).toEqual(["a"]);
    });
  });

  describe("failed touches", () => {
    for (const kind of ["read", "edit", "write"] as const) {
      it(`a failed ${kind} supersedes nothing`, () => {
        const found = findSuperseded([read("a", "src/app.ts", 2)], [
          { path: "src/app.ts", messageIndex: 8, kind, isError: true },
        ]);
        expect(found.size).toBe(0);
      });
    }

    it("a successful write after a failed edit still supersedes", () => {
      const found = findSuperseded([read("a", "src/app.ts", 2)], [
        { path: "src/app.ts", messageIndex: 6, kind: "edit", isError: true },
        { path: "src/app.ts", messageIndex: 8, kind: "write", isError: false },
      ]);
      expect([...found]).toEqual(["a"]);
    });
  });

  it("never marks non-read results", () => {
    const bash: ResultRef = {
      id: "b", toolName: "bash", input: { command: "cat src/app.ts" }, text: "out",
      tokens: 5000, messageIndex: 2, turnsAgo: 4, isError: false,
    };
    expect(findSuperseded([bash], [{ path: "src/app.ts", messageIndex: 5, kind: "edit" }]).size).toBe(0);
  });
});
