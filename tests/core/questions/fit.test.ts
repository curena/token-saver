import { describe, expect, it } from "vitest";
import { FIT_BATCH_SIZE, fitQuestions, fitState, parseFit } from "../../../src/core/questions/fit.js";
import type { FitLevel, InventoryItem, ProjectProfile } from "../../../src/core/types.js";

const profile: ProjectProfile = {
  root: "/home/u/proj",
  readme: "# proj\nA TypeScript CLI.",
  manifests: ['package.json: {"dependencies":{"vitest":"^2"}}'],
  tree: ["src/", "tests/"],
  prompts: ["fix the failing test", "add a flag to the CLI"],
};

const items: InventoryItem[] = [
  {
    id: "pdf",
    name: "pdf",
    kind: "skill",
    harness: "claude-code",
    source: "/s/pdf/SKILL.md",
    description: "Read, edit and create PDF files",
    tokens: 90,
    managed: true,
    currentState: "on",
  },
];

describe("fit questions", () => {
  it("puts the profile in state under named fields", () => {
    const state = fitState(profile);
    expect(state).toHaveProperty("readme");
    expect(state).toHaveProperty("recent_requests");
    expect(state).toHaveProperty("manifests");
  });

  it("builds one question per item, keyed by item id", () => {
    expect(Object.keys(fitQuestions(items))).toEqual(["fit::pdf"]);
  });

  it("gives every level a description that stands on its own", () => {
    // The SDK's Score builder indexes criteria by rubric position (0 = best fit), not by
    // name, so this is a tuple of four descriptions rather than a map.
    const q = fitQuestions(items)["fit::pdf"] as unknown as { criteria: readonly string[] };
    expect(q.criteria).toHaveLength(4);
    for (const text of q.criteria) expect(text.length).toBeGreaterThan(30);
  });

  it("names the item inside the instructions, not just the key", () => {
    const q = fitQuestions(items)["fit::pdf"] as unknown as { instructions: string };
    expect(q.instructions).toContain("Read, edit and create PDF files");
  });

  it("parses answers back to levels keyed by item id", () => {
    // Index 3 ("irrelevant") maps to FitLevel 4.
    const levels = parseFit({ "fit::pdf": { score: 3, confidence: 0.9 } });
    expect(levels.get("pdf")).toBe(4);
  });

  it("ignores answers for unknown keys", () => {
    expect(parseFit({ other: { score: 0 } }).size).toBe(0);
  });

  it("batches at 20 items", () => {
    expect(FIT_BATCH_SIZE).toBe(20);
  });

  it("rounds the rubric score to the nearest fit level, ties going to the worse fit", () => {
    const cases: Array<[number, FitLevel]> = [
      [0, 1],
      [0.4, 1],
      [0.5, 2],
      [2.5, 4],
      [3, 4],
      [3.9, 4],
      [-1, 1],
      [4, 4],
    ];
    for (const [input, expected] of cases) {
      const levels = parseFit({ "fit::pdf": { score: input } });
      expect(levels.get("pdf")).toBe(expected);
    }
  });

  it("omits an entry whose score is NaN", () => {
    expect(parseFit({ "fit::pdf": { score: Number.NaN } }).size).toBe(0);
  });

  it("omits an entry with no score at all", () => {
    expect(parseFit({ "fit::pdf": {} }).size).toBe(0);
  });
});
