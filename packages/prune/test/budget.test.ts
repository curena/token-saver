import { describe, expect, it } from "vitest";
import { emergencyLevel, nextArmAt, planBudgetCut, turnLevel } from "../src/policy/budget.js";

const LEVELS = { highWater: 0.75, lowWater: 0.3, contextLevel: 0.85 };

describe("planBudgetCut", () => {
  const candidates = [
    { id: "old", messageIndex: 5, expectedSave: 10_000 },
    { id: "mid", messageIndex: 20, expectedSave: 8_000 },
    { id: "new", messageIndex: 40, expectedSave: 6_000 },
  ];

  it("takes the latest start that meets the need", () => {
    const cut = planBudgetCut(candidates, 12_000);
    expect(cut.ids).toEqual(["mid", "new"]);
    expect(cut.fromIndex).toBe(20);
    expect(cut.expectedSave).toBe(14_000);
    expect(cut.reachesTarget).toBe(true);
  });

  it("takes only the newest when it alone is enough", () => {
    const cut = planBudgetCut(candidates, 5_000);
    expect(cut.ids).toEqual(["new"]);
    expect(cut.fromIndex).toBe(40);
  });

  it("takes everything when nothing reaches the need", () => {
    const cut = planBudgetCut(candidates, 100_000);
    expect(cut.ids).toEqual(["old", "mid", "new"]);
    expect(cut.fromIndex).toBe(5);
    expect(cut.expectedSave).toBe(24_000);
    expect(cut.reachesTarget).toBe(false);
  });

  it("sorts candidates by message index first", () => {
    const cut = planBudgetCut([...candidates].reverse(), 5_000);
    expect(cut.ids).toEqual(["new"]);
  });

  it("takes nothing when there is no need or no candidates", () => {
    expect(planBudgetCut(candidates, 0)).toEqual({ ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: true });
    expect(planBudgetCut([], 5_000)).toEqual({ ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: false });
  });
});

describe("emergencyLevel", () => {
  it("uses contextLevel when compaction is far away", () => {
    expect(emergencyLevel(1_000_000, 16_384, 0.85)).toBe(0.85);
  });

  it("caps just below pi's compaction point", () => {
    expect(emergencyLevel(100_000, 16_384, 0.85)).toBeCloseTo(0.81616, 5);
  });
});

describe("turnLevel", () => {
  it("is highWater on a large window", () => {
    expect(turnLevel(100_000, 16_384, LEVELS)).toBe(0.75);
  });

  it("drops to the emergency level on a small window", () => {
    expect(turnLevel(32_768, 16_384, LEVELS)).toBeCloseTo((32_768 - 16_384 - 2_000) / 32_768, 5);
  });
});

describe("nextArmAt", () => {
  it("returns the base when the sweep reached lowWater", () => {
    expect(nextArmAt(30_000, 100_000, LEVELS, 75_000, Infinity)).toBe(75_000);
  });

  it("waits for another high-minus-low of growth when the sweep fell short", () => {
    expect(nextArmAt(60_000, 100_000, LEVELS, 75_000, Infinity)).toBe(105_000);
  });

  it("never arms below the base", () => {
    expect(nextArmAt(31_000, 100_000, LEVELS, 90_000, Infinity)).toBe(90_000);
  });

  it("respects the cap", () => {
    expect(nextArmAt(60_000, 100_000, LEVELS, 81_616, 83_616)).toBe(83_616);
  });
});
