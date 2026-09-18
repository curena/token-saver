import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("separates positional targets from flag values", () => {
    const args = parseArgs(["sessions/a.jsonl", "--tau", "0.1,0.3", "--report", "out/"]);
    expect(args.targets).toEqual(["sessions/a.jsonl"]);
    expect(args.tau).toEqual([0.1, 0.3]);
    expect(args.report).toBe("out/");
  });

  it("does not treat a --report value as a session target", () => {
    const args = parseArgs(["sessions/", "--report", "/tmp/ts-out"]);
    expect(args.targets).toEqual(["sessions/"]);
    expect(args.report).toBe("/tmp/ts-out");
  });

  it("defaults when flags are absent", () => {
    expect(parseArgs(["a.jsonl"])).toEqual({ targets: ["a.jsonl"], tau: [0.3], report: "out" });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--model", "jev-1.13.0"])).toThrow(/unknown flag/);
  });
});
