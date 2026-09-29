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
    expect(parseArgs(["a.jsonl"])).toEqual({
      targets: ["a.jsonl"], tau: [0.3], report: "out", window: null, reserve: 16384, models: null,
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--model", "jev-1.13.0"])).toThrow(/unknown flag/);
  });

  it("parses --window, --reserve and --models", () => {
    const args = parseArgs(["s.jsonl", "--window", "100000", "--reserve", "8000", "--models", "m.json"]);
    expect(args.window).toBe(100000);
    expect(args.reserve).toBe(8000);
    expect(args.models).toBe("m.json");
    expect(args.targets).toEqual(["s.jsonl"]);
  });

  it("rejects a missing or non-numeric --window", () => {
    expect(() => parseArgs(["s.jsonl", "--window"])).toThrow(/--window needs a number/);
    expect(() => parseArgs(["s.jsonl", "--window", "big"])).toThrow(/--window needs a number/);
    expect(() => parseArgs(["s.jsonl", "--window", ""])).toThrow(/--window needs a number/);
  });

  it("rejects a non-positive --window", () => {
    expect(() => parseArgs(["s.jsonl", "--window", "0"])).toThrow(/--window must be > 0/);
    expect(() => parseArgs(["s.jsonl", "--window", "-5"])).toThrow(/--window must be > 0/);
  });

  it("rejects a missing, non-numeric or negative --reserve", () => {
    expect(() => parseArgs(["s.jsonl", "--reserve"])).toThrow(/--reserve needs a number/);
    expect(() => parseArgs(["s.jsonl", "--reserve", "Infinity"])).toThrow(/--reserve needs a number/);
    expect(() => parseArgs(["s.jsonl", "--reserve", "-1"])).toThrow(/--reserve must be >= 0/);
    expect(parseArgs(["s.jsonl", "--reserve", "0"]).reserve).toBe(0);
  });

  it("defaults window to null, reserve to 16384 and models to null", () => {
    const args = parseArgs(["s.jsonl"]);
    expect(args.window).toBeNull();
    expect(args.reserve).toBe(16384);
    expect(args.models).toBeNull();
  });
});
