import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countSkillUses, recentPrompts } from "../../src/audit/usage.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ts-usage-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function transcript(name: string, lines: unknown[]) {
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
}

const skillUse = (at: string, skill: string) => ({
  type: "assistant",
  timestamp: at,
  message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
});

const prompt = (at: string, text: string) => ({
  type: "user",
  timestamp: at,
  message: { content: text },
});

describe("countSkillUses", () => {
  it("counts Skill tool calls per skill name", () => {
    transcript("a.jsonl", [
      skillUse("2026-09-10T10:00:00Z", "pdf"),
      skillUse("2026-09-11T10:00:00Z", "pdf"),
      skillUse("2026-09-11T11:00:00Z", "docx"),
    ]);
    const counts = countSkillUses(dir, new Date("2026-09-01T00:00:00Z"));
    expect(counts.get("pdf")).toBe(2);
    expect(counts.get("docx")).toBe(1);
  });

  it("ignores uses older than the cutoff", () => {
    transcript("a.jsonl", [skillUse("2026-01-01T10:00:00Z", "pdf")]);
    expect(countSkillUses(dir, new Date("2026-09-01T00:00:00Z")).get("pdf")).toBeUndefined();
  });

  it("strips a plugin prefix so ids match the inventory", () => {
    transcript("a.jsonl", [skillUse("2026-09-10T10:00:00Z", "superpowers:brainstorming")]);
    expect(countSkillUses(dir, new Date("2026-09-01T00:00:00Z")).get("brainstorming")).toBe(1);
  });

  it("skips malformed lines without throwing", () => {
    writeFileSync(join(dir, "b.jsonl"), "not json\n", "utf8");
    expect(() => countSkillUses(dir, new Date("2026-09-01T00:00:00Z"))).not.toThrow();
  });

  it("returns nothing when the transcript directory is missing", () => {
    expect(countSkillUses(join(dir, "nope"), new Date(0)).size).toBe(0);
  });

  it("survives a transcript entry that is actually a directory", () => {
    mkdirSync(join(dir, "weird.jsonl"), { recursive: true });
    expect(() => countSkillUses(dir, new Date(0))).not.toThrow();
    expect(countSkillUses(dir, new Date(0)).size).toBe(0);
  });

  it("skips a line that parses to a non-object (null)", () => {
    writeFileSync(join(dir, "a.jsonl"), "null\n", "utf8");
    expect(() => countSkillUses(dir, new Date(0))).not.toThrow();
  });

  it("ignores an entry with a nonsense timestamp", () => {
    transcript("a.jsonl", [skillUse("not-a-real-date", "pdf")]);
    expect(countSkillUses(dir, new Date("2026-09-01T00:00:00Z")).get("pdf")).toBeUndefined();
  });

  it("ignores an entry with no timestamp at all", () => {
    transcript("a.jsonl", [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "pdf" } }] } },
    ]);
    expect(countSkillUses(dir, new Date(0)).get("pdf")).toBeUndefined();
  });
});

describe("recentPrompts", () => {
  it("returns the newest prompts first, up to the limit", () => {
    transcript("a.jsonl", [
      prompt("2026-09-10T10:00:00Z", "older request"),
      prompt("2026-09-12T10:00:00Z", "newer request"),
    ]);
    expect(recentPrompts(dir, 1)).toEqual(["newer request"]);
  });

  it("reads text blocks as well as plain strings", () => {
    transcript("a.jsonl", [
      { type: "user", timestamp: "2026-09-12T10:00:00Z", message: { content: [{ type: "text", text: "block form" }] } },
    ]);
    expect(recentPrompts(dir, 5)).toEqual(["block form"]);
  });

  it("redacts secrets found in prompts", () => {
    transcript("a.jsonl", [prompt("2026-09-12T10:00:00Z", "use API_KEY=abcdefghijklmnopqrstuv")]);
    expect(recentPrompts(dir, 5)[0]).toContain("[REDACTED]");
  });

  it("survives a transcript entry that is actually a directory", () => {
    mkdirSync(join(dir, "weird.jsonl"), { recursive: true });
    expect(() => recentPrompts(dir, 5)).not.toThrow();
    expect(recentPrompts(dir, 5)).toEqual([]);
  });

  it("skips a line that parses to a non-object (null)", () => {
    writeFileSync(join(dir, "a.jsonl"), "null\n", "utf8");
    expect(() => recentPrompts(dir, 5)).not.toThrow();
  });

  it("does not throw on a prompt with a nonsense timestamp", () => {
    transcript("a.jsonl", [prompt("not-a-real-date", "still useful text")]);
    expect(() => recentPrompts(dir, 5)).not.toThrow();
    expect(recentPrompts(dir, 5)).toEqual(["still useful text"]);
  });
});
