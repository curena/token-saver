import { describe, expect, it } from "vitest";
import { calibrateCharsPerToken, estimateTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("uses 4 characters per token by default", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("rounds up so non-empty text never estimates zero", () => {
    expect(estimateTokens("ab")).toBe(1);
  });

  it("returns zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("honours a calibrated ratio", () => {
    expect(estimateTokens("a".repeat(300), 3)).toBe(100);
  });
});

describe("calibrateCharsPerToken", () => {
  it("returns the fallback when there are no samples", () => {
    expect(calibrateCharsPerToken([], 4)).toBe(4);
  });

  it("derives the ratio from total characters over total tokens", () => {
    const ratio = calibrateCharsPerToken([
      { chars: 3000, tokens: 1000 },
      { chars: 3000, tokens: 1000 },
    ]);
    expect(ratio).toBeCloseTo(3, 5);
  });

  it("clamps to a sane range so one odd sample cannot wreck estimates", () => {
    expect(calibrateCharsPerToken([{ chars: 100, tokens: 1 }])).toBe(8);
    expect(calibrateCharsPerToken([{ chars: 1, tokens: 100 }])).toBe(2);
  });
});
