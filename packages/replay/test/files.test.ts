import { describe, expect, it, vi } from "vitest";
import { readSessionFiles } from "../src/files.js";

describe("readSessionFiles", () => {
  it("reads each file exactly once and keeps the snapshot stable", () => {
    const read = vi.fn((file: string) => `v0:${file}`);
    const sources = readSessionFiles(["a.jsonl", "b.jsonl"], read);

    expect(sources).toEqual([
      { file: "a.jsonl", text: "v0:a.jsonl" },
      { file: "b.jsonl", text: "v0:b.jsonl" },
    ]);
    expect(read).toHaveBeenCalledTimes(2);

    // The files change on disk after the snapshot was taken.
    read.mockImplementation((file: string) => `v1:${file}`);
    // The snapshot must stay frozen — the whole point of read-once.
    expect(sources[0]!.text).toBe("v0:a.jsonl");
    expect(sources[1]!.text).toBe("v0:b.jsonl");
  });
});