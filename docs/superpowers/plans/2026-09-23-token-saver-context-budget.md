# Context-Budget Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace token-saver's dollar cost gate with context-size triggers. A turn trigger sweeps at the user's message once context passes `highWater`, and shortens down to `lowWater`. An emergency trigger does the same mid-run just below pi's compaction point.

**Architecture:** New pure functions in `core/policy/budget.ts` choose the cut and the re-arm points. `runSweep` takes `currentTokens`/`targetTokens` instead of dollar inputs. The pi adapter decides the trigger from `getContextUsage()`, whether the last message is a user message, and in-memory arm points. The replay simulates the same triggers and reports context size, tokens re-processed and compactions avoided.

**Tech Stack:** TypeScript (ESM, workspaces), vitest, tsx. pi extension API (`@earendil-works/pi-coding-agent`).

**Spec:** `docs/superpowers/specs/2026-09-23-token-saver-context-budget-design.md`

## Global Constraints

- Defaults: `highWater` 0.75, `lowWater` 0.30, `contextLevel` 0.85; `costMargin` removed.
- Validation: `0 < lowWater < highWater < 1` and `highWater <= contextLevel`. Invalid → all three fall back to defaults with a `console.warn`.
- `emergencyLevel = min(contextLevel, (window - reserveTokens - 2000) / window)`. `reserveTokens` default 16384. The turn trigger uses `min(highWater, emergencyLevel)`.
- Turn trigger fires only when the last context message has role `"user"`.
- Unknown window or unknown token count → no sweep (stored decisions still applied).
- Decisions stay immutable. `/token-saver off` stops sweeps but keeps existing stubs.
- Tests: `npx vitest run <path>`. Typecheck: `npm run typecheck`. Full suite: `npm test`.
- Between Task 3 and Task 5, the pi and replay packages will not typecheck. Each task runs only its own package's tests until Task 5 restores the whole suite.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

---

### Task 1: Config keys for the water levels

**Files:**
- Modify: `packages/core/src/types.ts` (the `Config` interface)
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces: `Config.highWater: number`, `Config.lowWater: number`. `DEFAULT_CONFIG.contextLevel === 0.85`. `loadConfig` validates the three levels. `costMargin` stays in this task; Task 3 removes it.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("loadConfig", ...)` in `packages/core/test/config.test.ts`:

```ts
  it("defaults the water levels", () => {
    const config = loadConfig({ env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.lowWater).toBe(0.3);
    expect(config.contextLevel).toBe(0.85);
  });

  it("reads water levels from files and env", () => {
    const config = loadConfig({
      files: [fileWith({ highWater: 0.6, lowWater: 0.2 })],
      env: { TOKEN_SAVER_LOW_WATER: "0.25" },
    });
    expect(config.highWater).toBe(0.6);
    expect(config.lowWater).toBe(0.25);
  });

  it("falls back to default levels when lowWater is not below highWater", () => {
    const config = loadConfig({ files: [fileWith({ highWater: 0.3, lowWater: 0.5 })], env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.lowWater).toBe(0.3);
    expect(config.contextLevel).toBe(0.85);
  });

  it("falls back to default levels when highWater exceeds contextLevel", () => {
    const config = loadConfig({ files: [fileWith({ highWater: 0.9, contextLevel: 0.8 })], env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.contextLevel).toBe(0.85);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/config.test.ts`
Expected: the 4 new tests FAIL (`highWater` undefined, `contextLevel` 0.6).

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add to `Config` after `contextLevel: number;`:

```ts
  /** Turn-trigger level, as a fraction of the context window. */
  highWater: number;
  /** Sweep target, as a fraction of the context window. */
  lowWater: number;
```

In `packages/core/src/config.ts`:

```ts
export const DEFAULT_CONFIG: Config = {
  enabled: true,
  minResultTokens: 1500,
  protectTurns: 2,
  keepThreshold: 0.3,
  leaveAloneRatio: 0.7,
  minSaving: 500,
  costMargin: 1.5,
  contextLevel: 0.85,
  highWater: 0.75,
  lowWater: 0.3,
  expectedSaveRatio: 0.5,
  jevBudgetMs: 1500,
  jevModel: "jev-1.13.0",
  excludedTools: ["edit", "write"],
};

const NUMERIC_KEYS = [
  "minResultTokens", "protectTurns", "keepThreshold", "leaveAloneRatio",
  "minSaving", "costMargin", "contextLevel", "highWater", "lowWater",
  "expectedSaveRatio", "jevBudgetMs",
] as const;
```

Add before `return config;` at the end of `loadConfig`:

```ts
  const { lowWater, highWater, contextLevel } = config;
  if (!(0 < lowWater && lowWater < highWater && highWater < 1 && highWater <= contextLevel)) {
    console.warn(
      `token-saver: invalid levels (lowWater ${lowWater}, highWater ${highWater}, ` +
      `contextLevel ${contextLevel}); using defaults`,
    );
    config.lowWater = DEFAULT_CONFIG.lowWater;
    config.highWater = DEFAULT_CONFIG.highWater;
    config.contextLevel = DEFAULT_CONFIG.contextLevel;
  }
```

- [ ] **Step 4: Run the core tests**

Run: `npx vitest run packages/core`
Expected: all PASS. If a test in another core file asserted `contextLevel` 0.6, update the expectation to 0.85.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): add highWater/lowWater config and raise contextLevel to 0.85"
```

---

### Task 2: Budget policy functions

**Files:**
- Create: `packages/core/src/policy/budget.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/test/budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BudgetCandidate { id: string; messageIndex: number; expectedSave: number }
  export interface BudgetCut { ids: string[]; fromIndex: number; expectedSave: number; reachesTarget: boolean }
  export function planBudgetCut(candidates: BudgetCandidate[], need: number): BudgetCut
  export const COMPACTION_MARGIN = 2000
  export const DEFAULT_RESERVE_TOKENS = 16384
  export function emergencyLevel(window: number, reserveTokens: number, contextLevel: number): number
  export function turnLevel(window: number, reserveTokens: number, config: Pick<Config, "highWater" | "contextLevel">): number
  export function nextArmAt(reached: number, window: number, config: Pick<Config, "highWater" | "lowWater">, baseTokens: number, capTokens: number): number
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/budget.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/budget.test.ts`
Expected: FAIL, "Cannot find module '../src/policy/budget.js'".

- [ ] **Step 3: Implement**

Create `packages/core/src/policy/budget.ts`:

```ts
import type { Config } from "../types.js";

export interface BudgetCandidate {
  id: string;
  messageIndex: number;
  expectedSave: number;
}

export interface BudgetCut {
  ids: string[];
  /** Earliest shortened message index; everything from here is re-processed. -1 when empty. */
  fromIndex: number;
  expectedSave: number;
  reachesTarget: boolean;
}

/** Tokens kept between the emergency level and pi's compaction point. */
export const COMPACTION_MARGIN = 2000;
/** pi's default `compaction.reserveTokens`. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Choose which candidates to shorten so the expected saving covers `need`,
 * re-processing as little as possible. Re-processing covers everything after
 * the earliest shortened result, so take the latest start that is enough; if
 * none is, take everything.
 */
export function planBudgetCut(candidates: BudgetCandidate[], need: number): BudgetCut {
  if (need <= 0) return { ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: true };
  if (candidates.length === 0) return { ids: [], fromIndex: -1, expectedSave: 0, reachesTarget: false };

  const sorted = [...candidates].sort((a, b) => a.messageIndex - b.messageIndex);
  let saved = 0;
  for (let start = sorted.length - 1; start >= 0; start--) {
    saved += sorted[start]!.expectedSave;
    if (saved >= need) {
      const taken = sorted.slice(start);
      return { ids: taken.map((c) => c.id), fromIndex: taken[0]!.messageIndex, expectedSave: saved, reachesTarget: true };
    }
  }
  return { ids: sorted.map((c) => c.id), fromIndex: sorted[0]!.messageIndex, expectedSave: saved, reachesTarget: false };
}

/** pi compacts past `window - reserveTokens`; the emergency sweep must land before that. */
export function emergencyLevel(window: number, reserveTokens: number, contextLevel: number): number {
  return Math.min(contextLevel, (window - reserveTokens - COMPACTION_MARGIN) / window);
}

/** On small windows the emergency cap can fall below highWater; the turn trigger must still come first. */
export function turnLevel(
  window: number,
  reserveTokens: number,
  config: Pick<Config, "highWater" | "contextLevel">,
): number {
  return Math.min(config.highWater, emergencyLevel(window, reserveTokens, config.contextLevel));
}

/**
 * Token count at which a trigger fires again after a sweep that reached `reached`.
 * Reaching lowWater re-arms at the base level. Falling short waits for another
 * (highWater - lowWater) of growth, so a stuck context doesn't sweep, and make the
 * user wait, on every message.
 */
export function nextArmAt(
  reached: number,
  window: number,
  config: Pick<Config, "highWater" | "lowWater">,
  baseTokens: number,
  capTokens: number,
): number {
  if (reached <= config.lowWater * window) return baseTokens;
  const later = reached + (config.highWater - config.lowWater) * window;
  return Math.min(capTokens, Math.max(baseTokens, later));
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./policy/budget.js";
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/policy/budget.ts packages/core/src/index.ts packages/core/test/budget.test.ts
git commit -m "feat(core): budget policy — cut planning, trigger levels, re-arm points"
```

---

### Task 3: `runSweep` targets a token budget

**Files:**
- Modify: `packages/core/src/sweep.ts`
- Modify: `packages/core/src/types.ts` (`SweepEntryData.trigger`, remove `Config.costMargin`)
- Modify: `packages/core/src/config.ts` (remove `costMargin`)
- Test: `packages/core/test/sweep.test.ts`, `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: `planBudgetCut` (Task 2).
- Produces:
  ```ts
  export interface SweepInput {
    results: ResultRef[]; decided: ReadonlyMap<string, Decision>; touches: FileTouch[];
    task: TaskState; afterResultFor: (result: ResultRef) => string;
    /** Context tokens now. */ currentTokens: number;
    /** Context tokens to get down to. */ targetTokens: number;
    config: Config; client: JevClient; currentTurn: number;
    trigger: "turn" | "context"; signal?: AbortSignal;
  }
  export interface SweepOutcome {
    decisions: Decision[]; savedTokens: number; jevRequests: number; jevInputTokens: number;
    probabilitiesById: Record<string, number[]>;
    reason: "swept" | "at-target" | "no-candidates" | "nothing-shortened" | "judge-failed";
    /** Earliest shortened message index, -1 if none. */ fromIndex: number;
    /** currentTokens - savedTokens. */ reached: number;
  }
  // SweepEntryData.trigger: "turn" | "context" | "cost"   ("cost" only in old session entries)
  ```
- `planCostGate` and `policy/cost.ts` stay exported and unchanged except that `costMargin` is now passed by callers explicitly (it is already a `CostInput` field, so nothing changes there).

- [ ] **Step 1: Rewrite the sweep tests**

In `packages/core/test/sweep.test.ts`:
- Delete the `PRICES` constant.
- Replace the `input` helper with:

```ts
function input(over: Partial<SweepInput> = {}): SweepInput {
  const results = over.results ?? [bigRead("a", "src/app.ts", 10), bigRead("b", "src/other.ts", 12)];
  return {
    results,
    decided: new Map(),
    touches: [],
    task: { recent_user_messages: ["go"], latest_assistant_text: "", working_files: [] },
    afterResultFor: () => "",
    currentTokens: 80_000,
    targetTokens: 30_000,
    config: DEFAULT_CONFIG,
    client: allStale(),
    currentTurn: 9,
    trigger: "turn",
    ...over,
  };
}
```

- Delete the tests `"does nothing when the cost gate refuses"`, `"discards decisions when the real saving fails the gate"` and `"ignores the pre-gate for the context trigger"`.
- Change `"changes nothing when Jev fails"` to expect `reason` `"judge-failed"`, `decisions` `[]` and `reached` `80_000`.
- Add inside `describe("runSweep", ...)`:

```ts
  it("does nothing when already at target", async () => {
    const outcome = await runSweep(input({ currentTokens: 25_000 }));
    expect(outcome.reason).toBe("at-target");
    expect(outcome.decisions).toEqual([]);
    expect(outcome.reached).toBe(25_000);
  });

  it("shortens only the newest result when that covers the need", async () => {
    const perResult = bigRead("x", "x.ts", 1).tokens;
    // expectedSaveRatio 0.5: one result's expected saving is enough.
    const outcome = await runSweep(input({ currentTokens: 30_000 + Math.floor(perResult * 0.4) }));
    expect(outcome.decisions.map((d) => d.id)).toEqual(["b"]);
    expect(outcome.fromIndex).toBe(12);
  });

  it("reports the tokens reached", async () => {
    const outcome = await runSweep(input());
    expect(outcome.reason).toBe("swept");
    expect(outcome.reached).toBe(80_000 - outcome.savedTokens);
    expect(outcome.fromIndex).toBe(10);
  });

  it("keeps superseded stubs when Jev fails", async () => {
    const failing: JevClient = { systemOne: async () => { throw new Error("down"); } };
    const outcome = await runSweep(input({
      client: failing,
      touches: [{ path: "src/app.ts", messageIndex: 20, kind: "edit" }],
    }));
    expect(outcome.reason).toBe("judge-failed");
    expect(outcome.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(outcome.decisions[0]!.reason).toBe("superseded");
  });

  it("reports nothing-shortened when Jev keeps everything", async () => {
    const keepAll: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
      return { answers };
    } };
    const outcome = await runSweep(input({ client: keepAll }));
    expect(outcome.reason).toBe("nothing-shortened");
    expect(outcome.decisions).toEqual([]);
  });
```

In any remaining test that passes `trigger: "cost"`, `tokensAfter`, `callsSoFar` or `prices`, remove those keys. In `packages/core/test/config.test.ts`, remove any `costMargin` assertions or fixture keys.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/sweep.test.ts`
Expected: the new tests FAIL (`reached`/`fromIndex` undefined, reason mismatches).

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`: remove `costMargin: number;` from `Config`, and change `SweepEntryData`:

```ts
export interface SweepEntryData {
  decisions: Decision[];
  /** "cost" appears only in entries written before the context-budget triggers. */
  trigger: "turn" | "context" | "cost";
  at: string;
}
```

In `packages/core/src/config.ts`: remove `costMargin: 1.5,` from `DEFAULT_CONFIG` and `"costMargin"` from `NUMERIC_KEYS`.

Replace `packages/core/src/sweep.ts` up to (not including) `applyDecisions` with:

```ts
import { chunkResult } from "./chunk.js";
import { estimateTokens } from "./tokens.js";
import { buildRequest, judgeResult } from "./judge.js";
import type { JevClient, TaskState } from "./judge.js";
import { decideLevel } from "./policy/decide.js";
import { selectEligible } from "./policy/eligibility.js";
import { findSuperseded } from "./policy/staleness.js";
import type { FileTouch } from "./policy/staleness.js";
import { planBudgetCut } from "./policy/budget.js";
import { renderPartial, renderStub } from "./render.js";
import type { Config, Decision, ResultRef } from "./types.js";

export interface SweepInput {
  results: ResultRef[];
  decided: ReadonlyMap<string, Decision>;
  touches: FileTouch[];
  task: TaskState;
  afterResultFor: (result: ResultRef) => string;
  /** Context tokens now. */
  currentTokens: number;
  /** Context tokens to get down to. */
  targetTokens: number;
  config: Config;
  client: JevClient;
  currentTurn: number;
  trigger: "turn" | "context";
  signal?: AbortSignal;
}

export interface SweepOutcome {
  decisions: Decision[];
  savedTokens: number;
  jevRequests: number;
  /** Estimated Jev input tokens, for spend reporting. */
  jevInputTokens: number;
  /** Chunk probabilities per judged result, for the replay retention report. */
  probabilitiesById: Record<string, number[]>;
  reason: "swept" | "at-target" | "no-candidates" | "nothing-shortened" | "judge-failed";
  /** Earliest shortened message index; everything after it is re-processed. -1 if none. */
  fromIndex: number;
  /** Context tokens after the sweep: currentTokens - savedTokens. */
  reached: number;
}

export function firstLineOf(result: ResultRef): number {
  const offset = result.input.offset;
  return typeof offset === "number" && offset > 0 ? offset : 1;
}

export async function runSweep(input: SweepInput): Promise<SweepOutcome> {
  const { config, trigger } = input;
  const finish = (
    decisions: Decision[],
    reason: SweepOutcome["reason"],
    jevRequests = 0,
    jevInputTokens = 0,
    probabilitiesById: Record<string, number[]> = {},
  ): SweepOutcome => {
    const savedTokens = decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
    const indexes = decisions.map((d) => input.results.find((r) => r.id === d.id)!.messageIndex);
    return {
      decisions, savedTokens, jevRequests, jevInputTokens, probabilitiesById, reason,
      fromIndex: indexes.length > 0 ? Math.min(...indexes) : -1,
      reached: input.currentTokens - savedTokens,
    };
  };

  const need = input.currentTokens - input.targetTokens;
  if (need <= 0) return finish([], "at-target");

  const eligible = selectEligible(input.results, input.decided, config, {
    minTurnsAgo: trigger === "context" ? 1 : config.protectTurns,
  });
  if (eligible.length === 0) return finish([], "no-candidates");

  const superseded = findSuperseded(eligible, input.touches);
  const cut = planBudgetCut(
    eligible.map((result) => ({
      id: result.id,
      messageIndex: result.messageIndex,
      expectedSave: superseded.has(result.id)
        ? result.tokens
        : Math.round(result.tokens * config.expectedSaveRatio),
    })),
    need,
  );
  const chosen = new Set(cut.ids);
  // Superseded stubs first: they need no Jev call, so they survive a Jev failure.
  const ordered = eligible
    .filter((result) => chosen.has(result.id))
    .sort((a, b) => Number(superseded.has(b.id)) - Number(superseded.has(a.id)));

  const decisions: Decision[] = [];
  const probabilitiesById: Record<string, number[]> = {};
  let jevRequests = 0;
  let jevInputTokens = 0;

  for (const result of ordered) {
    const chunks = chunkResult(result.toolName, result.text, firstLineOf(result));
    const lineCount = result.text.split("\n").length;

    if (superseded.has(result.id)) {
      decisions.push({
        id: result.id, level: "stub", rendered: renderStub(result, lineCount),
        savedTokens: result.tokens, reason: "superseded", keptChunks: [],
        decidedAtTurn: input.currentTurn,
      });
      continue;
    }

    const request = buildRequest(result, chunks, input.task, input.afterResultFor(result), config);
    const probabilities = await judgeResult(input.client, request, chunks.length, config, input.signal);
    jevRequests++;
    jevInputTokens += estimateTokens(JSON.stringify(request));
    if (probabilities === null) {
      return finish(decisions, "judge-failed", jevRequests, jevInputTokens, probabilitiesById);
    }
    probabilitiesById[result.id] = probabilities;

    const plan = decideLevel(chunks, probabilities, config);
    if (plan.level === "leave") continue;
    decisions.push({
      id: result.id,
      level: plan.level,
      rendered: plan.level === "stub"
        ? renderStub(result, lineCount)
        : renderPartial(result, chunks, plan.keptChunks),
      savedTokens: plan.savedTokens,
      reason: "judged",
      keptChunks: plan.keptChunks,
      decidedAtTurn: input.currentTurn,
    });
  }

  return finish(
    decisions,
    decisions.length > 0 ? "swept" : "nothing-shortened",
    jevRequests, jevInputTokens, probabilitiesById,
  );
}
```

Keep `applyDecisions` unchanged below it.

- [ ] **Step 4: Run the core tests and typecheck core**

Run: `npx vitest run packages/core && npx tsc -b packages/core`
Expected: all PASS, no type errors in core. If `packages/core/test/cost.test.ts` fails to compile because of `Config`, it doesn't use `Config`, so it should pass unchanged. (`tsc -b packages/replay packages/pi` will fail until Tasks 4–5. That is expected.)

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core)!: runSweep targets a token budget instead of the dollar cost gate"
```

---

### Task 4: pi adapter — turn and emergency triggers

**Files:**
- Create: `packages/pi/src/settings.ts`
- Modify: `packages/pi/src/context.ts`
- Modify: `packages/pi/src/index.ts`
- Test: `packages/pi/test/settings.test.ts` (new), `packages/pi/test/context.test.ts`, `packages/pi/test/index.test.ts`

**Interfaces:**
- Consumes: `runSweep` / `SweepOutcome` (Task 3); `turnLevel`, `emergencyLevel`, `nextArmAt`, `DEFAULT_RESERVE_TOKENS` (Task 2).
- Produces:
  ```ts
  // settings.ts
  export function readReserveTokens(files: string[]): number   // last file with a valid value wins; default 16384
  // context.ts
  export interface Usage { tokens: number; window: number }
  export interface Arming { turnArmAt: number | null; emergencyArmAt: number | null }  // null = base level
  export interface HandleInput {
    messages: PiMessage[]; store: DecisionStore; config: Config; client: JevClient | null;
    usage: Usage | null; reserveTokens: number; arming: Arming; signal?: AbortSignal;
  }
  export interface HandleOutput {
    messages: PiMessage[] | null; sweep: SweepOutcome | null;
    trigger: "turn" | "context" | null; arming: Arming;
    /** Why no sweep ran, for /token-saver status. null when a sweep ran. */
    idle: "disabled" | "no-usage" | "below-level" | "mid-run" | null;
  }
  ```

- [ ] **Step 1: Write the settings test**

Create `packages/pi/test/settings.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReserveTokens } from "../src/settings.js";

const dirs: string[] = [];
function file(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("readReserveTokens", () => {
  it("defaults to pi's 16384", () => {
    expect(readReserveTokens([])).toBe(16384);
    expect(readReserveTokens(["/nonexistent/settings.json"])).toBe(16384);
  });

  it("reads compaction.reserveTokens, later files winning", () => {
    const global = file(JSON.stringify({ compaction: { reserveTokens: 20000 } }));
    const project = file(JSON.stringify({ compaction: { reserveTokens: 8000 } }));
    expect(readReserveTokens([global])).toBe(20000);
    expect(readReserveTokens([global, project])).toBe(8000);
  });

  it("ignores malformed files and bad values", () => {
    expect(readReserveTokens([file("{nope"), file(JSON.stringify({ compaction: { reserveTokens: -5 } }))])).toBe(16384);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement `settings.ts`**

Run: `npx vitest run packages/pi/test/settings.test.ts` (expected: FAIL, module not found).

Create `packages/pi/src/settings.ts`:

```ts
import { readFileSync } from "node:fs";
import { DEFAULT_RESERVE_TOKENS } from "@token-saver/core";

/**
 * pi's `compaction.reserveTokens` from its settings files (global, then project).
 * Extensions aren't handed pi's settings, so read the same files pi does.
 */
export function readReserveTokens(files: string[]): number {
  let reserve = DEFAULT_RESERVE_TOKENS;
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { compaction?: { reserveTokens?: unknown } };
      const value = parsed.compaction?.reserveTokens;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) reserve = value;
    } catch {
      // missing or malformed settings never break a session
    }
  }
  return reserve;
}
```

Run it again: expected PASS.

- [ ] **Step 3: Rewrite the context tests for the new triggers**

In `packages/pi/test/context.test.ts`:
- Delete the `PRICES` constant.
- Replace the `input` helper with:

```ts
const WINDOW = 100_000;

function input(over: Partial<HandleInput> = {}): HandleInput {
  return {
    messages: conversation(),
    store: new DecisionStore(),
    config: { ...DEFAULT_CONFIG, minResultTokens: 100 },
    client: stale,
    usage: { tokens: 20_000, window: WINDOW },
    reserveTokens: 16_384,
    arming: { turnArmAt: null, emergencyArmAt: null },
    ...over,
  };
}

/** The first context of a user turn ends with the user's message. */
function atTurnStart(messages: PiMessage[] = conversation()): PiMessage[] {
  return [...messages, { role: "user", content: "next step" }];
}
```

- Delete these tests, which cover removed behavior: `"forces a sweep when context usage crosses the level"`, `"does not force again until usage grows by ten points"`, `"forces again when new results become eligible"`, `"respects the cooldown after a refused post-gate"`, `"counts assistant tool-call arguments in the rewrite cost"`.
- In `"sweeps and replaces the stale result's text"` and in the three `handleContext supersession` tests, pass `messages: atTurnStart(...)` (wrapping whatever messages they built) and `usage: { tokens: 80_000, window: WINDOW }`. Expect `out.trigger` `"turn"` where they expected `"cost"`.
- In `"does not re-judge results Jev left alone within the same user turn"`: make the first call a turn start with `usage: { tokens: 80_000, window: WINDOW }`. Make the second call mid-run (no trailing user message) with `usage: { tokens: 85_000, window: WINDOW }`, which is above the 81.6% emergency level. Keep the assertion that no Jev request is sent for the left-alone result. The third call is a new user turn via `atTurnStart(...)` with `usage: { tokens: 80_000, window: WINDOW }`, and asserts exactly one Jev request. Replace `cooldownUntilTurn` arguments with `arming: first.arming` / `arming: second.arming`.
- In `"leaves the context untouched when Jev fails"`: use `atTurnStart()` and 80k usage; replace the `cooldownUntilTurn` assertion with `expect(out.arming.turnArmAt).toBeGreaterThan(75_000)`.
- Add:

```ts
describe("handleContext triggers", () => {
  it("does not sweep mid-run below the emergency level", async () => {
    const out = await handleContext(input({ usage: { tokens: 80_000, window: WINDOW } }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("mid-run");
  });

  it("does not sweep at a turn start below highWater", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 70_000, window: WINDOW } }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("below-level");
  });

  it("sweeps at a turn start at or above highWater, aiming for lowWater", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 76_000, window: WINDOW } }));
    expect(out.trigger).toBe("turn");
    expect(out.sweep?.decisions.length).toBe(1);
  });

  it("sweeps mid-run above the emergency level", async () => {
    const out = await handleContext(input({ usage: { tokens: 82_000, window: WINDOW } }));
    expect(out.trigger).toBe("context");
  });

  it("disarms the turn trigger when a sweep falls short of lowWater", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: { tokens: 76_000, window: WINDOW } }));
    // One ~2k-token result can't bring 76k down to 30k.
    const reached = out.sweep!.reached;
    expect(out.arming.turnArmAt).toBe(reached + 45_000);

    const again = await handleContext(input({
      messages: atTurnStart(), usage: { tokens: 77_000, window: WINDOW }, arming: out.arming,
    }));
    expect(again.sweep).toBeNull();
    expect(again.idle).toBe("below-level");
  });

  it("does not sweep when usage is unknown", async () => {
    const out = await handleContext(input({ messages: atTurnStart(), usage: null }));
    expect(out.sweep).toBeNull();
    expect(out.idle).toBe("no-usage");
  });
});
```

- [ ] **Step 4: Run the context tests to verify they fail**

Run: `npx vitest run packages/pi/test/context.test.ts`
Expected: FAIL (`idle`/`arming` undefined, triggers differ).

- [ ] **Step 5: Implement the new `handleContext`**

In `packages/pi/src/context.ts`:
- Change the core imports to:

```ts
import { emergencyLevel, estimateTokens, findSuperseded, nextArmAt, runSweep, turnLevel } from "@token-saver/core";
import type { Config, FileTouch, JevClient, ResultRef, SweepOutcome, TaskState } from "@token-saver/core";
```

- Replace `HandleInput` and `HandleOutput` with the interfaces from this task's **Interfaces** block (plus `Usage` and `Arming`).
- Delete `FORCE_STEP`, `COOLDOWN_TURNS` and `messageTokens`. Keep `textOf`, `lineArg`, the left-alone map, `pathArg`, `collectResults` and `withDecisions` unchanged.
- Replace `handleContext` with:

```ts
export async function handleContext(input: HandleInput): Promise<HandleOutput> {
  const idle = (reason: NonNullable<HandleOutput["idle"]>): HandleOutput => ({
    messages: withDecisions(input.messages, input.store),
    sweep: null, trigger: null, arming: input.arming, idle: reason,
  });
  // Decisions are immutable: "/token-saver off" stops sweeps but existing
  // stubs stay applied (spec §7); only the sweep is gated on `enabled`.
  if (!input.config.enabled || input.client === null) return idle("disabled");
  if (input.usage === null) return idle("no-usage");

  const { tokens, window } = input.usage;
  const { config, reserveTokens } = input;
  const turnBase = turnLevel(window, reserveTokens, config) * window;
  const emergencyBase = emergencyLevel(window, reserveTokens, config.contextLevel) * window;
  const compactionPoint = window - reserveTokens;
  const turnArmAt = input.arming.turnArmAt ?? turnBase;
  const emergencyArmAt = input.arming.emergencyArmAt ?? emergencyBase;

  // The first context of a turn ends with the user's message; mid-run ones end
  // with a tool result. Sweeping only there puts the re-processing wait where
  // the user already expects a pause.
  const atTurnStart = input.messages.at(-1)?.role === "user";
  const trigger: "turn" | "context" | null =
    tokens >= emergencyArmAt ? "context" : atTurnStart && tokens >= turnArmAt ? "turn" : null;
  if (trigger === null) return idle(atTurnStart ? "below-level" : "mid-run");

  const collected = collectResults(input.messages);
  const { touches, task, currentTurn } = collected;

  const leftAlone = leftAloneFor(input.store);
  for (const [id, turn] of leftAlone) if (turn !== currentTurn) leftAlone.delete(id);
  const recentlyLeft = collected.results.filter((result) => leftAlone.has(result.id));
  // Supersession needs no Jev call, so a left-alone read that a later edit
  // replaced can still be stubbed.
  const nowSuperseded = findSuperseded(recentlyLeft, touches);
  const results = collected.results.filter(
    (result) => !leftAlone.has(result.id) || nowSuperseded.has(result.id),
  );

  const outcome = await runSweep({
    results,
    decided: input.store.get(),
    touches,
    task,
    afterResultFor: (result) =>
      touches
        .filter((touch) => touch.messageIndex > result.messageIndex)
        .map((touch) => `${touch.kind} ${touch.path}`)
        .join("; "),
    currentTokens: tokens,
    targetTokens: config.lowWater * window,
    config,
    client: input.client,
    currentTurn,
    trigger,
    signal: input.signal,
  });

  input.store.add(outcome.decisions);
  for (const id of Object.keys(outcome.probabilitiesById)) {
    if (!input.store.get().has(id)) leftAlone.set(id, currentTurn);
  }

  return {
    messages: withDecisions(input.messages, input.store),
    sweep: outcome,
    trigger: outcome.decisions.length > 0 ? trigger : null,
    arming: {
      turnArmAt: nextArmAt(outcome.reached, window, config, turnBase, Infinity),
      emergencyArmAt: nextArmAt(outcome.reached, window, config, emergencyBase, compactionPoint),
    },
    idle: null,
  };
}
```

Note on the `idle` value: a turn start below its arm point reports `"below-level"`; any mid-run call below the emergency level reports `"mid-run"`. The tests above pin this.

If `estimateTokens` is now unused in `context.ts`, remove it from the import.

- [ ] **Step 6: Run the context tests**

Run: `npx vitest run packages/pi/test/context.test.ts`
Expected: all PASS.

- [ ] **Step 7: Wire `index.ts`**

In `packages/pi/src/index.ts`:
- Remove the `Prices` import, `priceOf`, `callsSoFar`, `cooldownUntilTurn`, `lastForcedFraction` and `lastForcedEligible`.
- Add imports:

```ts
import { readReserveTokens } from "./settings.js";
import type { Arming, HandleOutput } from "./context.js";
```

- Add state after `const client = ...`:

```ts
  const reserveTokens = readReserveTokens([
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ]);
  let arming: Arming = { turnArmAt: null, emergencyArmAt: null };
  let lastIdle: HandleOutput["idle"] = null;
  let lastUsage: { tokens: number; window: number } | null = null;
```

- In the `session_start` handler, add `arming = { turnArmAt: null, emergencyArmAt: null };` after `store.rebuildFrom(...)`.
- Replace the body of the `context` handler with:

```ts
    const raw = ctx.getContextUsage?.();
    const usage =
      raw && typeof raw.tokens === "number" && typeof raw.contextWindow === "number" && raw.contextWindow > 0
        ? { tokens: raw.tokens, window: raw.contextWindow }
        : null;
    lastUsage = usage;

    const outcome = await handleContext({
      messages: event.messages as PiMessage[],
      store,
      config,
      client,
      usage,
      reserveTokens,
      arming,
      signal: ctx.signal,
    });

    arming = outcome.arming;
    lastIdle = outcome.idle;
    if (outcome.sweep !== null) jevTokens += outcome.sweep.jevInputTokens;

    if (outcome.sweep !== null && outcome.sweep.decisions.length > 0 && outcome.trigger !== null) {
      const data: SweepEntryData = {
        decisions: outcome.sweep.decisions,
        trigger: outcome.trigger,
        at: new Date().toISOString(),
      };
      pi.appendEntry(SWEEP_ENTRY, data);
    }
    return outcome.messages === null ? undefined : { messages: outcome.messages };
```

- Replace the stats `ctx.ui.notify(...)` at the end of the command handler with:

```ts
      const stats = store.stats();
      const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
      let levels = "context size unknown (no sweeps)";
      if (lastUsage !== null) {
        const { tokens, window } = lastUsage;
        const turnAt = arming.turnArmAt ?? turnLevel(window, reserveTokens, config) * window;
        const emergencyAt = arming.emergencyArmAt ?? emergencyLevel(window, reserveTokens, config.contextLevel) * window;
        levels =
          `context ${k(tokens)}/${k(window)} (${((tokens / window) * 100).toFixed(0)}%), ` +
          `next sweep at ${k(turnAt)} on your message, emergency ${k(emergencyAt)}, target ${k(config.lowWater * window)}`;
      }
      ctx.ui.notify(
        `token-saver: ${levels}. ${stats.stubbed} stubbed, ${stats.partial} partial, ` +
        `~${k(stats.savedTokens)} tokens freed, ${recalls} recalls, ` +
        `jev spend ~$${(jevTokens * JEV_PRICE_PER_TOKEN).toFixed(4)}` +
        (lastIdle === "disabled" ? " (off)" : ""),
        "info",
      );
```

and add `turnLevel, emergencyLevel` to the `@token-saver/core` import (`import { emergencyLevel, loadConfig, turnLevel } from "@token-saver/core";`).

- [ ] **Step 8: Update the index test**

In `packages/pi/test/index.test.ts`, the fake `ctx` must provide `getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 })`. The context event's `messages` must end with a `{ role: "user", ... }` message on the call that is expected to sweep. Adjust the existing tests' fakes accordingly. Their assertions (a result is shortened; restore appends `RESTORE_ENTRY`; the context is no longer rewritten after rebuild) stay the same.

- [ ] **Step 9: Run the pi tests and typecheck**

Run: `npx vitest run packages/pi && npx tsc -b packages/core packages/pi`
Expected: all PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add packages/pi
git commit -m "feat(pi): turn and emergency context-budget triggers; read pi reserveTokens"
```

---

### Task 5: Replay simulates the budget triggers

**Files:**
- Modify: `packages/replay/src/session.ts` (`CallSite.atTurnStart`)
- Modify: `packages/replay/src/args.ts` (`--window`, `--reserve`, `--models`)
- Create: `packages/replay/src/windows.ts`
- Modify: `packages/replay/src/run.ts`
- Modify: `packages/replay/src/report.ts`
- Modify: `packages/replay/src/cli.ts`
- Test: `packages/replay/test/session.test.ts`, `packages/replay/test/args.test.ts`, `packages/replay/test/windows.test.ts` (new), `packages/replay/test/run.test.ts`, `packages/replay/test/report.test.ts`

**Interfaces:**
- Consumes: `runSweep`, `turnLevel`, `emergencyLevel`, `nextArmAt` (Tasks 2–3).
- Produces:
  ```ts
  // session.ts: CallSite gains
  atTurnStart: boolean   // the message before this assistant call is a user message
  // args.ts
  export interface CliArgs { targets: string[]; tau: number[]; report: string; window: number | null; reserve: number; models: string | null }
  // windows.ts
  export function loadModelWindows(path: string): Map<string, number>   // model id -> contextWindow; empty on error
  // run.ts
  export interface ReplayOptions { window: number | null; reserveTokens: number }
  export async function replaySession(jsonl, name, client, config, options: ReplayOptions): Promise<ReplayMetrics>
  // ReplayMetrics gains: window: number | null; peakBefore; peakAfter; contextSumBefore; contextSumAfter;
  //   compactionsBefore; compactionsAfter.  rewrittenTokens keeps its name and now means "tokens re-processed".
  // report.ts: summarize(all, prices?) gains peakBefore, peakAfter, meanBefore, meanAfter,
  //   compactionsBefore, compactionsAfter, reprocessedTokens, skippedSessions (window null)
  ```

- [ ] **Step 1: `atTurnStart` in `session.ts` (test first)**

Add to `packages/replay/test/session.test.ts`:

```ts
describe("turn starts", () => {
  it("marks the first call after a user message", () => {
    const lines = [
      { type: "message", id: "1", message: { role: "user", content: "go" } },
      { type: "message", id: "2", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] } },
      { type: "message", id: "3", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x" }] } },
      { type: "message", id: "4", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const sites = parseSession(lines);
    expect(sites.map((site) => site.atTurnStart)).toEqual([true, false]);
  });
});
```

Run `npx vitest run packages/replay/test/session.test.ts`: expected FAIL. Then in `session.ts`:
- Add `atTurnStart: boolean;` to `CallSite` (with a doc comment: "The previous message is the user's: pi's turn trigger can fire here.").
- In `parseSession`, keep `let previousRole = "";`. Set `previousRole = message.role;` at the end of each message's handling. Make sure it is also set on the `continue` paths for user and toolResult, e.g. assign it at the top of the loop body after reading the previous value. When pushing a site, set `atTurnStart: previousRole === "user"`.

Run again: expected PASS. If the existing fixture-based tests assert whole `CallSite` objects with `toEqual`, add `atTurnStart` to their expectations.

- [ ] **Step 2: CLI flags (test first)**

Add to `packages/replay/test/args.test.ts`:

```ts
  it("parses --window, --reserve and --models", () => {
    const args = parseArgs(["s.jsonl", "--window", "100000", "--reserve", "8000", "--models", "m.json"]);
    expect(args.window).toBe(100000);
    expect(args.reserve).toBe(8000);
    expect(args.models).toBe("m.json");
    expect(args.targets).toEqual(["s.jsonl"]);
  });

  it("defaults window to null, reserve to 16384 and models to null", () => {
    const args = parseArgs(["s.jsonl"]);
    expect(args.window).toBeNull();
    expect(args.reserve).toBe(16384);
    expect(args.models).toBeNull();
  });
```

Run: expected FAIL. Update `args.ts`:

```ts
export interface CliArgs {
  targets: string[];
  tau: number[];
  report: string;
  /** Context window for every session; overrides the models file. */
  window: number | null;
  /** pi's compaction.reserveTokens. */
  reserve: number;
  /** pi models-store.json, for per-model context windows. */
  models: string | null;
}
```

In `parseArgs`, initialise `let window: number | null = null; let reserve = 16384; let models: string | null = null;` and add branches:

```ts
    if (arg === "--window") { window = Number(argv[++i]); continue; }
    if (arg === "--reserve") { reserve = Number(argv[++i]); continue; }
    if (arg === "--models") { models = argv[++i] ?? null; continue; }
```

Return `{ targets, tau, report, window, reserve, models }`. Run: expected PASS.

- [ ] **Step 3: Model windows (test first)**

Create `packages/replay/test/windows.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelWindows } from "../src/windows.js";

describe("loadModelWindows", () => {
  it("maps model ids to context windows from a pi models store", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ts-models-")), "models-store.json");
    writeFileSync(path, JSON.stringify({
      openrouter: { models: [{ id: "~deepseek/deepseek-pro-latest", contextWindow: 163840 }, { id: "nowin" }] },
    }));
    const windows = loadModelWindows(path);
    expect(windows.get("~deepseek/deepseek-pro-latest")).toBe(163840);
    expect(windows.has("nowin")).toBe(false);
  });

  it("returns an empty map for a missing file", () => {
    expect(loadModelWindows("/nonexistent/models.json").size).toBe(0);
  });
});
```

Run: expected FAIL. Create `packages/replay/src/windows.ts`:

```ts
import { readFileSync } from "node:fs";

/** Model id -> context window, from pi's models-store.json (any nesting). */
export function loadModelWindows(path: string): Map<string, number> {
  const windows = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return windows;
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const model = node as { id?: unknown; contextWindow?: unknown };
    if (typeof model.id === "string" && typeof model.contextWindow === "number" && model.contextWindow > 0) {
      windows.set(model.id, model.contextWindow);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(parsed);
  return windows;
}
```

Run: expected PASS.

- [ ] **Step 4: `replaySession` simulates the triggers (test first)**

In `packages/replay/test/run.test.ts`, change every existing `replaySession(jsonl, name, client, config, PRICES)` call to pass `{ window: 2_000, reserveTokens: 0 }` instead of `PRICES`, and delete `PRICES`. The fixture is small, so a 2k window makes its results cross 75%. If an existing test's expectation depended on the cost gate refusing, recompute it by running the test and checking the new behaviour against the spec: sweep only at turn starts ≥ 75%, or at any call ≥ the emergency level. Then add:

```ts
describe("replaySession budget metrics", () => {
  it("skips sweeps and marks the session when the window is unknown", async () => {
    const metrics = await replaySession(jsonl, "s", stale, DEFAULT_CONFIG, { window: null, reserveTokens: 0 });
    expect(metrics.window).toBeNull();
    expect(metrics.sweeps).toBe(0);
    expect(metrics.jevRequests).toBe(0);
  });

  it("tracks peak context and compactions before and after", async () => {
    const config = { ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0 };
    const metrics = await replaySession(jsonl, "s", stale, config, { window: 2_000, reserveTokens: 0 });
    expect(metrics.peakBefore).toBeGreaterThan(0);
    expect(metrics.peakAfter).toBeLessThanOrEqual(metrics.peakBefore);
    expect(metrics.compactionsAfter).toBeLessThanOrEqual(metrics.compactionsBefore);
    if (metrics.sweeps > 0) expect(metrics.rewrittenTokens).toBeGreaterThan(0);
  });
});
```

Run `npx vitest run packages/replay/test/run.test.ts`: expected FAIL.

Implement in `packages/replay/src/run.ts`:
- Imports:

```ts
import { applyDecisions, chunkResult, emergencyLevel, firstLineOf, nextArmAt, runSweep, turnLevel } from "@token-saver/core";
import type { Config, Decision, JevClient } from "@token-saver/core";
```

- Add fields to `ReplayMetrics`:

```ts
  window: number | null;
  /** Largest simulated context (all message tokens) at any call, without / with token-saver. */
  peakBefore: number;
  peakAfter: number;
  /** Sum of simulated context over all calls; divide by calls for the mean. */
  contextSumBefore: number;
  contextSumAfter: number;
  /** Times the context crossed pi's compaction point (window - reserve), without / with. */
  compactionsBefore: number;
  compactionsAfter: number;
```

and change the doc comment on `rewrittenTokens` to `/** Tokens re-processed because a sweep changed history before them (the waiting cost). */`.

- Add `export interface ReplayOptions { window: number | null; reserveTokens: number }` and change the last parameter of `replaySession` from `prices: Prices | null` to `options: ReplayOptions`.
- Initialise the new metrics to `window: options.window` and zeros. Declare `let turnArmAt: number | null = null; let emergencyArmAt: number | null = null; let wasOverBefore = false; let wasOverAfter = false;`.
- Per call site, before the sweep:

```ts
    const contextBefore = site.tokenCounts.reduce((sum, tokens) => sum + (tokens ?? 0), 0);
    const savedSoFar = site.results.reduce((sum, result) => sum + (decided.get(result.id)?.savedTokens ?? 0), 0);
    let contextAfter = contextBefore - savedSoFar;
```

- Replace the `if (config.enabled) { ... runSweep ... }` block's trigger decision and `runSweep` call with:

```ts
    const window = options.window;
    if (config.enabled && window !== null) {
      const turnBase = turnLevel(window, options.reserveTokens, config) * window;
      const emergencyBase = emergencyLevel(window, options.reserveTokens, config.contextLevel) * window;
      const trigger =
        contextAfter >= (emergencyArmAt ?? emergencyBase) ? "context"
        : site.atTurnStart && contextAfter >= (turnArmAt ?? turnBase) ? "turn"
        : null;

      if (trigger !== null) {
        const startedAt = Date.now();
        const outcome = await runSweep({
          results: site.results,
          decided,
          touches: site.touches,
          task: {
            recent_user_messages: site.recentUserMessages.slice(-2),
            latest_assistant_text: site.latestAssistantText,
            working_files: site.workingFiles,
          },
          afterResultFor: (result) => afterResultSummary(site, result),
          currentTokens: contextAfter,
          targetTokens: config.lowWater * window,
          config,
          client,
          currentTurn: site.userTurn,
          trigger,
        });
        metrics.sweepMs += Date.now() - startedAt;
        metrics.jevRequests += outcome.jevRequests;
        metrics.jevInputTokens += outcome.jevInputTokens;
        turnArmAt = nextArmAt(outcome.reached, window, config, turnBase, Infinity);
        emergencyArmAt = nextArmAt(outcome.reached, window, config, emergencyBase, window - options.reserveTokens);
        contextAfter = outcome.reached;

        if (outcome.decisions.length > 0) {
          metrics.sweeps++;
          metrics.rewrittenTokens += suffixTokens(site, outcome.fromIndex);
          // …keep the existing per-decision loop unchanged (decided.set, stubbed/partial
          // counts, chunkResult, detectMisses with collectLaterUses(jsonl, site.entryIndex - 1)).
        }
      }
    }
```

The existing `fromIndex = Math.min(...)` computation is replaced by `outcome.fromIndex`. Keep the per-decision loop body exactly as it is now.

- After the sweep block, before the existing `applyDecisions` accounting:

```ts
    metrics.peakBefore = Math.max(metrics.peakBefore, contextBefore);
    metrics.peakAfter = Math.max(metrics.peakAfter, contextAfter);
    metrics.contextSumBefore += contextBefore;
    metrics.contextSumAfter += contextAfter;
    if (options.window !== null) {
      const point = options.window - options.reserveTokens;
      const overBefore = contextBefore > point;
      const overAfter = contextAfter > point;
      if (overBefore && !wasOverBefore) metrics.compactionsBefore++;
      if (overAfter && !wasOverAfter) metrics.compactionsAfter++;
      wasOverBefore = overBefore;
      wasOverAfter = overAfter;
    }
```

Leave the existing `tokensBefore`/`tokensAfter` (tool-result tokens, used by the dollar column) as they are.

Run: expected PASS.

- [ ] **Step 5: Report columns (test first)**

In `packages/replay/test/report.test.ts`, update any `ReplayMetrics` fixtures to include the new fields: `window: 100_000, peakBefore, peakAfter, contextSumBefore, contextSumAfter, compactionsBefore, compactionsAfter`. Then add:

```ts
  it("summarizes context size, re-processing and compactions", () => {
    const base = sampleMetrics(); // existing helper in this file; if absent, build one ReplayMetrics literal
    const summary = summarize([
      { ...base, calls: 2, peakBefore: 90_000, peakAfter: 50_000, contextSumBefore: 160_000, contextSumAfter: 100_000,
        compactionsBefore: 1, compactionsAfter: 0, rewrittenTokens: 20_000, window: 100_000 },
      { ...base, calls: 1, peakBefore: 10_000, peakAfter: 10_000, contextSumBefore: 10_000, contextSumAfter: 10_000,
        compactionsBefore: 0, compactionsAfter: 0, rewrittenTokens: 0, window: null },
    ]);
    expect(summary.peakBefore).toBe(90_000);
    expect(summary.peakAfter).toBe(50_000);
    expect(summary.meanBefore).toBeCloseTo(170_000 / 3);
    expect(summary.meanAfter).toBeCloseTo(110_000 / 3);
    expect(summary.compactionsBefore).toBe(1);
    expect(summary.compactionsAfter).toBe(0);
    expect(summary.reprocessedTokens).toBe(20_000);
    expect(summary.skippedSessions).toBe(1);
  });
```

If `report.test.ts` has no `sampleMetrics` helper, define one at the top of the file that returns a complete `ReplayMetrics` literal with zeros, `misses: []`, `session: "s"`, `calls: 1` and `window: 100_000`.

Run: expected FAIL. In `report.ts`:
- Add to `Summary`: `peakBefore: number; peakAfter: number; meanBefore: number; meanAfter: number; compactionsBefore: number; compactionsAfter: number; reprocessedTokens: number; skippedSessions: number;`.
- In `summarize`, compute:

```ts
  const calls = all.reduce((sum, m) => sum + m.calls, 0);
  const peakBefore = Math.max(0, ...all.map((m) => m.peakBefore));
  const peakAfter = Math.max(0, ...all.map((m) => m.peakAfter));
  const meanBefore = calls === 0 ? 0 : all.reduce((s, m) => s + m.contextSumBefore, 0) / calls;
  const meanAfter = calls === 0 ? 0 : all.reduce((s, m) => s + m.contextSumAfter, 0) / calls;
  const compactionsBefore = all.reduce((s, m) => s + m.compactionsBefore, 0);
  const compactionsAfter = all.reduce((s, m) => s + m.compactionsAfter, 0);
  const skippedSessions = all.filter((m) => m.window === null).length;
```

and return them, with `reprocessedTokens: total.rewrittenTokens`.
- In `renderReport`, make the main table:

```
| tau | peak ctx before | peak ctx after | mean ctx before | mean ctx after | sweeps | re-processed | compactions before | compactions after | misses | jev reqs | jev $ | net $ |
```

Format token counts as `Math.round(n).toLocaleString("en-US")`. After the existing notes, add:
`Re-processed is the tokens prompt-processed again after sweeps: the waiting cost. Net $ is secondary.`
and, when `skippedSessions > 0`, the line `N session(s) skipped: unknown context window (pass --window).`.

Run `npx vitest run packages/replay/test/report.test.ts`: expected PASS.

- [ ] **Step 6: Wire the CLI**

In `packages/replay/src/cli.ts`:
- Import `loadModelWindows` from `./windows.js` and `homedir` from `node:os`.
- Destructure the new args: `const { targets, tau: taus, report: outDir, window, reserve, models } = parseArgs(process.argv.slice(2));`.
- After building `sessions`:

```ts
const modelWindows = loadModelWindows(models ?? join(homedir(), ".pi", "agent", "models-store.json"));
function windowFor(text: string): number | null {
  if (window !== null) return window;
  const match = /"model":"([^"]+)"/.exec(text);
  return match === null ? null : modelWindows.get(match[1]!) ?? null;
}
```

- Replace `DEFAULT_PRICES` in the `replaySession` call with `{ window: windowFor(session.text), reserveTokens: reserve }`. Keep `DEFAULT_PRICES` imported only if still used; `summarize` defaults to it.
- Change the per-tau console line to:

```ts
  console.log(
    `tau ${tau}: peak ${Math.round(summary.peakBefore)} -> ${Math.round(summary.peakAfter)}, ` +
    `mean ${Math.round(summary.meanBefore)} -> ${Math.round(summary.meanAfter)}, ` +
    `${summary.sweeps} sweeps, ${Math.round(summary.reprocessedTokens)} re-processed, ` +
    `compactions ${summary.compactionsBefore} -> ${summary.compactionsAfter}, ${summary.misses} misses` +
    (summary.skippedSessions > 0 ? ` (${summary.skippedSessions} skipped: no window)` : ""),
  );
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all test files PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/replay
git commit -m "feat(replay): simulate turn/emergency triggers; report context size, re-processing, compactions"
```

---

### Task 6: Docs and the real replay run

**Files:**
- Modify: `README.md` (settings table and replay usage)
- Modify: `docs/superpowers/notes/replay-baseline.md`

- [ ] **Step 1: Update the README**

In `README.md`'s settings table:
- Remove the `costMargin` row.
- Change `contextLevel` to default `0.85`, described as "Emergency sweep level (capped just below pi's compaction point)".
- Add rows: `highWater` | `0.75` | "Sweep at your next message once context passes this fraction of the window", and `lowWater` | `0.30` | "Sweep target, as a fraction of the window".

In the replay section, add `--window <tokens>` ("context window for every session; otherwise looked up from `~/.pi/agent/models-store.json`"), `--reserve <tokens>` (default 16384) and `--models <path>`. Add an example for local sessions:

```bash
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions/--home-archie-- --window 100000 --tau 0.3 --report out/qwen-budget
```

- [ ] **Step 2: Run the replay over the local Qwen sessions**

The llama-cpp sessions are in `--home-archie--`, `--data-llama.cpp-adaptive-kv-streaming--`, `--data-tools-ASCII-Condensed-prune-tools--`, `--home-archie-workspace-test--` and `--tmp-tmp.o1bhmBmKQB-repo--` under `~/.pi/agent/sessions/`. Copy the earlier Jev cache so identical requests aren't paid twice:

```bash
mkdir -p out/qwen-budget && cp out/representative-v2/jev-cache.json out/qwen-budget/
S=~/.pi/agent/sessions
npx tsx packages/replay/src/cli.ts "$S/--home-archie--" "$S/--data-llama.cpp-adaptive-kv-streaming--" \
  "$S/--data-tools-ASCII-Condensed-prune-tools--" "$S/--home-archie-workspace-test--" "$S/--tmp-tmp.o1bhmBmKQB-repo--" \
  --window 100000 --tau 0.3 --report out/qwen-budget
```

Expected: a per-tau line with peak and mean context before → after, sweeps, re-processed tokens and compactions. Also run the hoard DeepSeek sessions without `--window`, so the window comes from the models store:

```bash
mkdir -p out/deepseek-budget && cp out/representative-v2/jev-cache.json out/deepseek-budget/
npx tsx packages/replay/src/cli.ts "$S/--home-archie-workspace-hoard--" --tau 0.3 --report out/deepseek-budget
```

This makes paid Jev calls. Get the user's go-ahead before running if it's not already given.

- [ ] **Step 3: Record the results**

Add a section `## Context-budget run (YYYY-MM-DD)` to `docs/superpowers/notes/replay-baseline.md`, using the run date. Include both result tables copied from `out/qwen-budget/report.md` and `out/deepseek-budget/report.md`, the exact commands, and 3–5 bullets on what the numbers say:
- peak and mean context reduction
- sweeps per session and re-processed tokens per sweep
- compactions avoided
- misses

Update the status line at the top of the file to point to this section.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/notes/replay-baseline.md
git commit -m "docs: context-budget settings and replay results"
```
