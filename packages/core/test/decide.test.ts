import { describe, expect, it } from "vitest";
import { decideLevel } from "../src/policy/decide.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Chunk } from "../src/types.js";

function chunks(tokensEach: number[]): Chunk[] {
  let line = 1;
  return tokensEach.map((tokens, index) => {
    const chunk: Chunk = {
      index, startLine: line, endLine: line + 19,
      text: `chunk ${index}`, tokens,
    };
    line += 20;
    return chunk;
  });
}

describe("decideLevel", () => {
  it("stubs when no chunk reaches the keep threshold", () => {
    const plan = decideLevel(chunks([2000, 2000]), [0.05, 0.1], DEFAULT_CONFIG);
    expect(plan.level).toBe("stub");
    expect(plan.keptChunks).toEqual([]);
    expect(plan.savedTokens).toBe(4000 - 40);
  });

  it("leaves the result alone when kept tokens reach leaveAloneRatio", () => {
    const plan = decideLevel(chunks([1000, 1000, 1000, 1000]), [0.9, 0.9, 0.9, 0.1], DEFAULT_CONFIG);
    expect(plan.level).toBe("leave");
    expect(plan.savedTokens).toBe(0);
  });

  it("keeps only chunks at or above the threshold when in between", () => {
    const plan = decideLevel(chunks([1000, 1000, 1000, 1000]), [0.9, 0.05, 0.05, 0.31], DEFAULT_CONFIG);
    expect(plan.level).toBe("partial");
    expect(plan.keptChunks).toEqual([0, 3]);
    expect(plan.savedTokens).toBe(2000 - 40);
  });

  it("treats the threshold as inclusive", () => {
    const plan = decideLevel(chunks([1000, 3000]), [0.3, 0.01], DEFAULT_CONFIG);
    expect(plan.keptChunks).toEqual([0]);
  });

  it("leaves the result alone when the saving is under minSaving", () => {
    // Kept 600 of 1000 is below leaveAloneRatio, so this reaches the minSaving
    // rule: 1000 - 600 - 40 = 360, under the 500 floor.
    const plan = decideLevel(chunks([600, 400]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(plan.level).toBe("leave");
  });

  it("subtracts marker overhead from the saving", () => {
    const plan = decideLevel(chunks([9000]), [0.01], DEFAULT_CONFIG, 100);
    expect(plan.savedTokens).toBe(8900);
  });

  it("stubs when there are no chunks to keep and probabilities are missing", () => {
    const plan = decideLevel(chunks([3000]), [], DEFAULT_CONFIG);
    expect(plan.level).toBe("stub");
  });
});
