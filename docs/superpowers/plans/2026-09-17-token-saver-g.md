# token-saver G (stale-result pruning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pi extension that replaces stale tool results in the model context with verbatim excerpts or one-line stubs, judged by TypeSafe's Jev model, plus an offline replay harness that measures the savings and the misses.

**Architecture:** An npm workspace with three packages. `@token-saver/core` is pure TypeScript with no pi imports: chunking, Jev judgments, policy (eligibility, staleness, three-level decision, cache-aware cost gate), rendering, config. `@token-saver/pi` is the extension: a `context` handler that applies immutable decisions and occasionally sweeps, a `recall` tool, commands, and TUI rendering. `@token-saver/replay` runs the same core over recorded `.jsonl` sessions and reports tokens saved against retention misses.

**Tech Stack:** TypeScript 5.x (strict), Node >= 20, npm workspaces, vitest, esbuild (bundling the extension), `@typesafe-ai/sdk` (Jev), pi 0.85.1 extension API.

**Spec:** `docs/superpowers/specs/2026-09-17-token-saver-g-design.md`

## Global Constraints

- Node >= 20; TypeScript `strict: true`; ESM (`"type": "module"`) throughout.
- `packages/core` must not import anything from pi (`@earendil-works/*`) or from `node:fs` outside `config.ts`. The replay harness and the extension share it.
- Jev model is pinned: `jev-1.13.0`. Never use an alias in code.
- **Selection, never generation:** every line shown to the agent is copied verbatim from the original result. No summarising, no rewording.
- **Decisions are immutable:** once a result has a decision, it is applied identically forever. `recall` appends; it never reverts.
- **Fail-open:** any Jev error, timeout, abort, or missing API key leaves the context untouched.
- Defaults, exact values from the spec: `minResultTokens` 1500, `protectTurns` 2, `keepThreshold` 0.3, `leaveAloneRatio` 0.7, `minSaving` 500, `costMargin` 1.5, `contextLevel` 0.60, `expectedSaveRatio` 0.5, `jevBudgetMs` 1500, `N = clamp(callsSoFar, 3, 40)`, no-cache sweep floor `S >= 4000`.
- Marker text is fixed: stubs and partials both start with `[token-saver] `.
- Commit after every task, with a message in the form `feat(core): ...`, `test(...)`, `feat(pi): ...`.

---

## File Structure

```
package.json                      workspace root, scripts, vitest config
tsconfig.base.json                strict TS settings shared by packages
packages/core/
  package.json
  src/types.ts                    shared types: ResultRef, Chunk, Decision, Prices, Config
  src/tokens.ts                   estimateTokens, calibrateCharsPerToken
  src/chunk.ts                    chunkResult (read / bash / generic)
  src/render.ts                   renderStub, renderPartial
  src/config.ts                   defaults, file + env loading (only fs user in core)
  src/judge.ts                    JevClient interface, buildQuestions, judgeResult
  src/policy/eligibility.ts       selectEligible
  src/policy/staleness.ts         findSuperseded
  src/policy/decide.ts            decideLevel
  src/policy/cost.ts              planCostGate
  src/sweep.ts                    runSweep (orchestrator), applyDecisions
  test/*.test.ts                  one file per module above
packages/replay/
  package.json
  src/session.ts                  parse .jsonl -> entries -> call sites
  src/run.ts                      replay a session through core, collect metrics
  src/retention.ts                miss detection for elided chunks
  src/report.ts                   markdown + JSON report, tau curve
  src/cli.ts                      token-saver-replay entry point
  src/jevCache.ts                 on-disk cache of Jev answers
  test/*.test.ts
packages/pi/
  package.json
  src/index.ts                    extension entry: events, tool, commands
  src/state.ts                    decision store, rebuild from session entries
  src/context.ts                  context-event handler: apply + trigger + sweep
  src/recall.ts                   recall tool definition
  src/ui.ts                       entry renderer + /token-saver commands
  build.mjs                       esbuild bundle -> dist/token-saver.js
  test/*.test.ts
```

---

### Task 1: Workspace scaffold, shared types, token estimation

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore` (append), `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/types.ts`, `packages/core/src/tokens.ts`
- Test: `packages/core/test/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: all shared types below, plus `estimateTokens(text: string, charsPerToken?: number): number` and `calibrateCharsPerToken(samples: Array<{ chars: number; tokens: number }>, fallback?: number): number`.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "token-saver",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/core packages/replay packages/pi"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
```

`packages/core/package.json`:

```json
{
  "name": "@token-saver/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@typesafe-ai/sdk": "^0.6.0" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Append to `.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
out/
```

Run: `npm install`

- [ ] **Step 2: Write the shared types**

`packages/core/src/types.ts`:

```ts
/** One tool result as it appears in the model context. */
export interface ResultRef {
  /** The originating tool call's id; also the recall handle. */
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Full result text, all text blocks joined with "\n". */
  text: string;
  tokens: number;
  /** Index in the context message array. */
  messageIndex: number;
  /** Completed user turns since this result. 0 = current turn. */
  turnsAgo: number;
  isError: boolean;
}

export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
}

export type Level = "stub" | "partial" | "leave";

export interface Decision {
  id: string;
  level: Level;
  /** Replacement text; null when level is "leave". */
  rendered: string | null;
  savedTokens: number;
  reason: "superseded" | "judged";
  /** Chunk indices kept verbatim; empty for "stub" and "leave". */
  keptChunks: number[];
  decidedAtTurn: number;
}

export interface SweepEntryData {
  decisions: Decision[];
  trigger: "cost" | "context";
  at: string;
}

/** Per-token prices. null prices mean the provider has no prompt caching. */
export interface Prices {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Config {
  enabled: boolean;
  minResultTokens: number;
  protectTurns: number;
  keepThreshold: number;
  leaveAloneRatio: number;
  minSaving: number;
  costMargin: number;
  contextLevel: number;
  expectedSaveRatio: number;
  jevBudgetMs: number;
  jevModel: string;
  excludedTools: string[];
}
```

- [ ] **Step 3: Write the failing test**

`packages/core/test/tokens.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/tokens.test.ts`
Expected: FAIL, cannot resolve `../src/tokens.js`.

- [ ] **Step 5: Implement**

`packages/core/src/tokens.ts`:

```ts
const MIN_RATIO = 2;
const MAX_RATIO = 8;

export function estimateTokens(text: string, charsPerToken = 4): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function calibrateCharsPerToken(
  samples: Array<{ chars: number; tokens: number }>,
  fallback = 4,
): number {
  let chars = 0;
  let tokens = 0;
  for (const sample of samples) {
    chars += sample.chars;
    tokens += sample.tokens;
  }
  if (tokens <= 0) return fallback;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, chars / tokens));
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/tokens.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts .gitignore packages/core
git commit -m "feat(core): workspace scaffold, shared types, token estimation"
```

---

### Task 2: Chunking

**Files:**
- Create: `packages/core/src/chunk.ts`
- Test: `packages/core/test/chunk.test.ts`

**Interfaces:**
- Consumes: `Chunk` from `types.ts`, `estimateTokens` from `tokens.ts`.
- Produces: `chunkResult(toolName: string, text: string, firstLine?: number): Chunk[]`. Chunks cover every line exactly once, in order; `firstLine` (default 1) is the real file line number of the first line, so offset reads keep true numbering.

- [ ] **Step 1: Write the failing test**

`packages/core/test/chunk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkResult } from "../src/chunk.js";

const line = (n: number) => `line ${n}`;

describe("chunkResult", () => {
  it("covers every line exactly once, in order", () => {
    const text = Array.from({ length: 250 }, (_, i) => line(i + 1)).join("\n");
    const chunks = chunkResult("bash", text);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(250);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
      expect(chunks[i]!.index).toBe(i);
    }
    expect(chunks.map((c) => c.text).join("\n")).toBe(text);
  });

  it("offsets line numbers when a read started partway through a file", () => {
    const text = Array.from({ length: 30 }, (_, i) => line(i)).join("\n");
    const chunks = chunkResult("read", text, 101);
    expect(chunks[0]!.startLine).toBe(101);
    expect(chunks.at(-1)!.endLine).toBe(130);
  });

  it("splits a read at top-level declarations", () => {
    const body = (name: string) =>
      [
        `export function ${name}() {`,
        ...Array.from({ length: 9 }, (_, i) => `  const step${i} = ${i};`),
        "  return 0;",
        "}",
      ].join("\n");
    const text = [body("alpha"), body("beta"), body("gamma")].join("\n");
    const chunks = chunkResult("read", text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]!.text.startsWith("export function ")).toBe(true);
  });

  it("splits bash output at blank lines", () => {
    const block = (n: number) => Array.from({ length: 25 }, (_, i) => `${n}:${i}`).join("\n");
    const text = `${block(1)}\n\n${block(2)}`;
    const chunks = chunkResult("bash", text);
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.text.startsWith("2:0")).toBe(true);
  });

  it("keeps chunks within the per-tool maximum", () => {
    const text = Array.from({ length: 500 }, (_, i) => line(i)).join("\n");
    for (const [tool, max] of [["read", 60], ["bash", 40], ["other", 40]] as const) {
      for (const chunk of chunkResult(tool, text)) {
        expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(max);
      }
    }
  });

  it("returns a single chunk for short text", () => {
    expect(chunkResult("bash", "one\ntwo")).toHaveLength(1);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkResult("bash", "")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/chunk.test.ts`
Expected: FAIL, cannot resolve `../src/chunk.js`.

- [ ] **Step 3: Implement**

`packages/core/src/chunk.ts`:

```ts
import type { Chunk } from "./types.js";
import { estimateTokens } from "./tokens.js";

/**
 * `isBoundary(line, previous)` answers "does a new chunk start AT `line`?".
 * Blank-line separation keys off `previous`, so the blank ends the chunk
 * before it rather than heading the chunk after it.
 */
interface Shape {
  min: number;
  max: number;
  isBoundary: (line: string, previous: string | undefined) => boolean;
}

const DECLARATION = /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum|def|impl|fn|struct|public|private|protected)\b/;

const SHAPES: Record<string, Shape> = {
  read: {
    min: 20,
    max: 60,
    isBoundary: (line, previous) =>
      DECLARATION.test(line) || (previous !== undefined && previous.trim() === ""),
  },
  bash: {
    min: 20,
    max: 40,
    isBoundary: (line, previous) =>
      previous !== undefined &&
      (previous.trim() === "" || prefix(line) !== prefix(previous)),
  },
  generic: { min: 40, max: 40, isBoundary: () => false },
};

/** Leading non-alphanumeric run plus first word: a cheap "does this line look like the last one". */
function prefix(line: string): string {
  return line.slice(0, 12).replace(/[0-9]+/g, "#");
}

export function chunkResult(toolName: string, text: string, firstLine = 1): Chunk[] {
  if (text.length === 0) return [];
  const shape = SHAPES[toolName] ?? SHAPES.generic!;
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let start = 0;

  for (let i = 1; i <= lines.length; i++) {
    const size = i - start;
    const atEnd = i === lines.length;
    const boundary =
      size >= shape.min && !atEnd && shape.isBoundary(lines[i]!, lines[i - 1]);
    if (atEnd || boundary || size >= shape.max) {
      const slice = lines.slice(start, i);
      const body = slice.join("\n");
      chunks.push({
        index: chunks.length,
        startLine: firstLine + start,
        endLine: firstLine + i - 1,
        text: body,
        tokens: estimateTokens(body),
      });
      start = i;
    }
  }
  return chunks;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/chunk.test.ts`
Expected: PASS, 7 tests. If the blank-line case splits one line late, the boundary check must look at `lines[i]` (the first line of the *next* chunk), not `lines[i - 1]`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chunk.ts packages/core/test/chunk.test.ts
git commit -m "feat(core): split tool results into chunks by tool shape"
```

---

### Task 3: Eligibility

**Files:**
- Create: `packages/core/src/policy/eligibility.ts`
- Test: `packages/core/test/eligibility.test.ts`

**Interfaces:**
- Consumes: `ResultRef`, `Decision`, `Config`.
- Produces: `selectEligible(results: ResultRef[], decided: ReadonlyMap<string, Decision>, config: Config, options?: { minTurnsAgo?: number }): ResultRef[]`. `options.minTurnsAgo` overrides `config.protectTurns` for the context-limit trigger, which relaxes it to 1.

- [ ] **Step 1: Write the failing test**

`packages/core/test/eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectEligible } from "../src/policy/eligibility.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";

function ref(over: Partial<ResultRef> = {}): ResultRef {
  return {
    id: "call_1",
    toolName: "read",
    input: { path: "src/app.ts" },
    text: "x".repeat(40_000),
    tokens: 10_000,
    messageIndex: 4,
    turnsAgo: 5,
    isError: false,
    ...over,
  };
}

const none = new Map<string, Decision>();

describe("selectEligible", () => {
  it("accepts a large, old, undecided result", () => {
    expect(selectEligible([ref()], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("protects results from the last protectTurns turns", () => {
    expect(selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ turnsAgo: 3 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });

  it("honours a relaxed minTurnsAgo for the context-limit trigger", () => {
    const relaxed = selectEligible([ref({ turnsAgo: 2 })], none, DEFAULT_CONFIG, {
      minTurnsAgo: 1,
    });
    expect(relaxed).toHaveLength(1);
  });

  it("skips results under minResultTokens", () => {
    expect(selectEligible([ref({ tokens: 1499 })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips errors", () => {
    expect(selectEligible([ref({ isError: true })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips excluded tools", () => {
    expect(selectEligible([ref({ toolName: "edit" })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "write" })], none, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips results that already have a decision", () => {
    const decided = new Map<string, Decision>([
      ["call_1", {
        id: "call_1", level: "stub", rendered: "[token-saver] ...",
        savedTokens: 9000, reason: "judged", keptChunks: [], decidedAtTurn: 3,
      }],
    ]);
    expect(selectEligible([ref()], decided, DEFAULT_CONFIG)).toEqual([]);
  });

  it("skips recall output from the protected window but not older recalls", () => {
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 2 })], none, DEFAULT_CONFIG)).toEqual([]);
    expect(selectEligible([ref({ toolName: "recall", turnsAgo: 9 })], none, DEFAULT_CONFIG)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Write the config defaults the test imports**

`packages/core/src/config.ts` (loading from files and env comes in Task 10; only the defaults exist now):

```ts
import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  minResultTokens: 1500,
  protectTurns: 2,
  keepThreshold: 0.3,
  leaveAloneRatio: 0.7,
  minSaving: 500,
  costMargin: 1.5,
  contextLevel: 0.6,
  expectedSaveRatio: 0.5,
  jevBudgetMs: 1500,
  jevModel: "jev-1.13.0",
  excludedTools: ["edit", "write"],
};
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/eligibility.test.ts`
Expected: FAIL, cannot resolve `../src/policy/eligibility.js`.

- [ ] **Step 4: Implement**

`packages/core/src/policy/eligibility.ts`:

```ts
import type { Config, Decision, ResultRef } from "../types.js";

export function selectEligible(
  results: ResultRef[],
  decided: ReadonlyMap<string, Decision>,
  config: Config,
  options: { minTurnsAgo?: number } = {},
): ResultRef[] {
  const minTurnsAgo = options.minTurnsAgo ?? config.protectTurns;
  return results.filter((result) => {
    if (decided.has(result.id)) return false;
    if (result.isError) return false;
    if (result.tokens < config.minResultTokens) return false;
    if (config.excludedTools.includes(result.toolName)) return false;
    // Recall output is protected by the same window: recalling then immediately
    // re-stubbing would strand the agent.
    return result.turnsAgo > minTurnsAgo;
  });
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/eligibility.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/policy/eligibility.ts packages/core/test/eligibility.test.ts
git commit -m "feat(core): eligibility rules and config defaults"
```

---

### Task 4: Superseded reads

**Files:**
- Create: `packages/core/src/policy/staleness.ts`
- Test: `packages/core/test/staleness.test.ts`

**Interfaces:**
- Consumes: `ResultRef`.
- Produces:
  ```ts
  export interface FileTouch { path: string; messageIndex: number; kind: "read" | "edit" | "write"; }
  export function findSuperseded(results: ResultRef[], touches: FileTouch[]): Set<string>;
  export function pathOf(result: ResultRef): string | null;
  ```
  A `read` result is superseded when a later touch (`messageIndex` greater than the result's) hits the same path. `pathOf` reads `input.path` or `input.file_path`, normalising nothing else.

- [ ] **Step 1: Write the failing test**

`packages/core/test/staleness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findSuperseded, pathOf } from "../src/policy/staleness.js";
import type { ResultRef } from "../src/types.js";

function read(id: string, path: string, messageIndex: number): ResultRef {
  return {
    id, toolName: "read", input: { path }, text: "body",
    tokens: 5000, messageIndex, turnsAgo: 4, isError: false,
  };
}

describe("pathOf", () => {
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

  it("never marks non-read results", () => {
    const bash: ResultRef = {
      id: "b", toolName: "bash", input: { command: "cat src/app.ts" }, text: "out",
      tokens: 5000, messageIndex: 2, turnsAgo: 4, isError: false,
    };
    expect(findSuperseded([bash], [{ path: "src/app.ts", messageIndex: 5, kind: "edit" }]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/staleness.test.ts`
Expected: FAIL, cannot resolve `../src/policy/staleness.js`.

- [ ] **Step 3: Implement**

`packages/core/src/policy/staleness.ts`:

```ts
import type { ResultRef } from "../types.js";

export interface FileTouch {
  path: string;
  messageIndex: number;
  kind: "read" | "edit" | "write";
}

export function pathOf(result: ResultRef): string | null {
  const input = result.input;
  for (const key of ["path", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function findSuperseded(results: ResultRef[], touches: FileTouch[]): Set<string> {
  const superseded = new Set<string>();
  for (const result of results) {
    if (result.toolName !== "read") continue;
    const path = pathOf(result);
    if (path === null) continue;
    const later = touches.some(
      (touch) => touch.path === path && touch.messageIndex > result.messageIndex,
    );
    if (later) superseded.add(result.id);
  }
  return superseded;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/staleness.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/policy/staleness.ts packages/core/test/staleness.test.ts
git commit -m "feat(core): detect reads superseded by later file activity"
```

---

### Task 5: The three-level decision

**Files:**
- Create: `packages/core/src/policy/decide.ts`
- Test: `packages/core/test/decide.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `Config`, `Level`.
- Produces:
  ```ts
  export interface LevelPlan { level: Level; keptChunks: number[]; savedTokens: number; }
  export function decideLevel(chunks: Chunk[], probabilities: number[], config: Config, overheadTokens?: number): LevelPlan;
  ```
  `probabilities[i]` is Jev's answer for `chunks[i]`. `overheadTokens` (default 40) is what the marker and gap lines add back, so `savedTokens` is honest. Rules in order: every chunk below `keepThreshold` → `stub`; kept tokens >= `leaveAloneRatio` of total → `leave`; otherwise `partial`; then if `savedTokens < minSaving` → `leave`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/decide.test.ts`:

```ts
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

  it("keeps a chunk whose probability is missing", () => {
    const plan = decideLevel(chunks([3000]), [], DEFAULT_CONFIG);
    expect(plan.level).toBe("leave");
    expect(plan.savedTokens).toBe(0);
  });

  it("keeps the unscored chunk when the probabilities run short", () => {
    const plan = decideLevel(chunks([2000, 2000, 2000]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(plan.keptChunks).toEqual([0, 2]);
  });

  it("treats leaveAloneRatio as inclusive", () => {
    const at = decideLevel(chunks([7000, 3000]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(at.level).toBe("leave");
    const under = decideLevel(chunks([6900, 3100]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(under.level).toBe("partial");
    expect(under.savedTokens).toBe(3100 - 40);
  });

  it("treats minSaving as inclusive", () => {
    // 1700 - 1160 - 40 = 500 exactly, with kept tokens under leaveAloneRatio.
    const at = decideLevel(chunks([1160, 540]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(at.level).toBe("partial");
    expect(at.savedTokens).toBe(500);
    const under = decideLevel(chunks([1161, 539]), [0.9, 0.01], DEFAULT_CONFIG);
    expect(under.level).toBe("leave");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/decide.test.ts`
Expected: FAIL, cannot resolve `../src/policy/decide.js`.

- [ ] **Step 3: Implement**

`packages/core/src/policy/decide.ts`:

```ts
import type { Chunk, Config, Level } from "../types.js";

export interface LevelPlan {
  level: Level;
  keptChunks: number[];
  savedTokens: number;
}

const LEAVE: LevelPlan = { level: "leave", keptChunks: [], savedTokens: 0 };

export function decideLevel(
  chunks: Chunk[],
  probabilities: number[],
  config: Config,
  overheadTokens = 40,
): LevelPlan {
  const total = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
  if (total === 0) return LEAVE;

  const kept = chunks.filter((chunk) => keepScore(probabilities[chunk.index]) >= config.keepThreshold);
  const keptTokens = kept.reduce((sum, chunk) => sum + chunk.tokens, 0);

  if (keptTokens >= total * config.leaveAloneRatio) return LEAVE;

  const savedTokens = total - keptTokens - overheadTokens;
  if (savedTokens < config.minSaving) return LEAVE;

  return {
    level: kept.length === 0 ? "stub" : "partial",
    keptChunks: kept.map((chunk) => chunk.index),
    savedTokens,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/decide.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/policy/decide.ts packages/core/test/decide.test.ts
git commit -m "feat(core): three-level decision from chunk probabilities"
```

---

### Task 6: Rendering stubs and partials

**Files:**
- Create: `packages/core/src/render.ts`
- Test: `packages/core/test/render.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `ResultRef`.
- Produces:
  ```ts
  export function describeResult(result: ResultRef): string;   // "read src/app.ts" | "bash: npm test" | "grep"
  export function renderStub(result: ResultRef, lineCount: number): string;
  export function renderPartial(result: ResultRef, chunks: Chunk[], keptChunks: number[]): string;
  ```
  Partials number every kept line with the chunk's real line numbers, `%4d| ` style, and mark each gap as `… lines A–B elided …`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeResult, renderPartial, renderStub } from "../src/render.js";
import type { Chunk, ResultRef } from "../src/types.js";

const result: ResultRef = {
  id: "call_83", toolName: "read", input: { path: "src/app.ts" },
  text: "", tokens: 9800, messageIndex: 4, turnsAgo: 5, isError: false,
};

function chunk(index: number, startLine: number, lines: string[]): Chunk {
  return {
    index, startLine, endLine: startLine + lines.length - 1,
    text: lines.join("\n"), tokens: lines.length * 4,
  };
}

describe("describeResult", () => {
  it("names the file for a read", () => {
    expect(describeResult(result)).toBe("read src/app.ts");
  });

  it("shows a truncated command for bash", () => {
    const bash = { ...result, toolName: "bash", input: { command: "npm test -- --runInBand extra long tail here" } };
    expect(describeResult(bash)).toMatch(/^bash: npm test/);
    expect(describeResult(bash).length).toBeLessThanOrEqual(60);
  });

  it("falls back to the tool name", () => {
    expect(describeResult({ ...result, toolName: "grep", input: {} })).toBe("grep");
  });
});

describe("renderStub", () => {
  it("states what was removed and how to get it back", () => {
    const text = renderStub(result, 412);
    expect(text).toContain("[token-saver]");
    expect(text).toContain("read src/app.ts");
    expect(text).toContain("412 lines");
    expect(text).toContain('recall({id:"call_83"})');
    expect(text.split("\n")).toHaveLength(1);
  });
});

describe("renderPartial", () => {
  const chunks = [
    chunk(0, 1, ["alpha", "beta"]),
    chunk(1, 3, ["gamma", "delta"]),
    chunk(2, 5, ["epsilon"]),
  ];

  it("keeps chosen chunks verbatim with real line numbers", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).toContain("   1| alpha");
    expect(text).toContain("   2| beta");
    expect(text).toContain("   5| epsilon");
  });

  it("marks each gap with its line range and the recall id", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).toContain("… lines 3–4 elided …");
    expect(text).toContain('recall({id:"call_83"');
  });

  it("does not leak elided text", () => {
    const text = renderPartial(result, chunks, [0, 2]);
    expect(text).not.toContain("gamma");
    expect(text).not.toContain("delta");
  });

  it("emits kept chunks in line order regardless of the kept list order", () => {
    const text = renderPartial(result, chunks, [2, 0]);
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("epsilon"));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/render.test.ts`
Expected: FAIL, cannot resolve `../src/render.js`.

- [ ] **Step 3: Implement**

`packages/core/src/render.ts`:

```ts
import type { Chunk, ResultRef } from "./types.js";
import { pathOf } from "./policy/staleness.js";

const MARKER = "[token-saver]";

/** Budget for a command description. A path is never truncated: it is the one
 *  part of a stub the agent needs intact to decide whether to recall it. */
const MAX_COMMAND_DESCRIPTION = 60;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function describeResult(result: ResultRef): string {
  const path = pathOf(result);
  if (path !== null) return `${result.toolName} ${path}`;
  const command = result.input.command;
  if (typeof command === "string") {
    const head = command.split("\n")[0]!;
    // Truncate the whole composed string, not just the command: an MCP tool
    // name can be longer than the budget on its own.
    return truncate(`${result.toolName}: ${head}`, MAX_COMMAND_DESCRIPTION);
  }
  return result.toolName;
}

function approxTokens(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tok` : `~${tokens} tok`;
}

export function renderStub(result: ResultRef, lineCount: number): string {
  return (
    `${MARKER} ${describeResult(result)}: ${lineCount} lines (${approxTokens(result.tokens)}) ` +
    `elided as no longer needed. recall({id:"${result.id}"}) to restore; startLine/endLine for part.`
  );
}

export function renderPartial(result: ResultRef, chunks: Chunk[], keptChunks: number[]): string {
  const kept = new Set(keptChunks);
  const lines: string[] = [
    `${MARKER} ${describeResult(result)}: showing lines still relevant; ` +
      `recall({id:"${result.id}", startLine, endLine}) for gaps.`,
  ];

  let gapStart: number | null = null;
  const flushGap = (endLine: number) => {
    if (gapStart === null) return;
    lines.push(`… lines ${gapStart}–${endLine} elided …`);
    gapStart = null;
  };

  for (const chunk of chunks) {
    if (kept.has(chunk.index)) {
      flushGap(chunk.startLine - 1);
      chunk.text.split("\n").forEach((line, offset) => {
        lines.push(`${String(chunk.startLine + offset).padStart(4, " ")}| ${line}`);
      });
    } else if (gapStart === null) {
      gapStart = chunk.startLine;
    }
  }
  flushGap(chunks.at(-1)?.endLine ?? 0);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/render.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/render.ts packages/core/test/render.test.ts
git commit -m "feat(core): render stubs and partials with gap markers"
```

---

### Task 7: The cache-aware cost gate

**Files:**
- Create: `packages/core/src/policy/cost.ts`
- Test: `packages/core/test/cost.test.ts`

**Interfaces:**
- Consumes: `Prices`.
- Produces:
  ```ts
  export interface CostCandidate { id: string; messageIndex: number; expectedSave: number; }
  export interface CostInput {
    candidates: CostCandidate[];          // ascending messageIndex
    tokensAfter: (messageIndex: number) => number;  // tokens from that message to the end, inclusive
    callsSoFar: number;
    prices: Prices | null;                // null = provider has no prompt caching
    costMargin: number;
    noCacheFloor?: number;                // default 4000
  }
  export interface CostPlan { sweep: boolean; fromIndex: number; ids: string[]; value: number; cost: number; }
  export function expectedCalls(callsSoFar: number): number;   // clamp(callsSoFar, 3, 40)
  export function planCostGate(input: CostInput): CostPlan;
  ```
  `planCostGate` tries every candidate as the earliest changed position, keeps the best `value − cost`, and sweeps only when `value >= costMargin × cost`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/cost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectedCalls, planCostGate } from "../src/policy/cost.js";
import type { CostInput } from "../src/policy/cost.js";

// Anthropic-shaped per-token prices (per Mtok: $3 input, $0.30 cache read, $3.75 cache write).
const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function input(over: Partial<CostInput> = {}): CostInput {
  return {
    candidates: [{ id: "a", messageIndex: 10, expectedSave: 40_000 }],
    tokensAfter: () => 50_000,
    callsSoFar: 20,
    prices: PRICES,
    costMargin: 1.5,
    ...over,
  };
}

describe("expectedCalls", () => {
  it("clamps to between 3 and 40", () => {
    expect(expectedCalls(0)).toBe(3);
    expect(expectedCalls(12)).toBe(12);
    expect(expectedCalls(400)).toBe(40);
  });
});

describe("planCostGate", () => {
  it("sweeps when large results sit behind a short suffix", () => {
    const plan = planCostGate(input());
    expect(plan.sweep).toBe(true);
    expect(plan.ids).toEqual(["a"]);
    expect(plan.fromIndex).toBe(10);
  });

  it("does not sweep when the saving is small behind a long suffix", () => {
    const plan = planCostGate(input({
      candidates: [{ id: "a", messageIndex: 4, expectedSave: 20_000 }],
      tokensAfter: () => 60_000,
      callsSoFar: 15,
    }));
    expect(plan.sweep).toBe(false);
  });

  it("prefers a later starting point when the early candidate drags in a long suffix", () => {
    const plan = planCostGate(input({
      candidates: [
        { id: "early", messageIndex: 2, expectedSave: 1_600 },
        { id: "late", messageIndex: 30, expectedSave: 40_000 },
      ],
      tokensAfter: (index) => (index <= 2 ? 200_000 : 45_000),
    }));
    expect(plan.sweep).toBe(true);
    expect(plan.ids).toEqual(["late"]);
    expect(plan.fromIndex).toBe(30);
  });

  it("uses the floor instead of the cache maths when the provider has no caching", () => {
    const noCache = { prices: null, candidates: [{ id: "a", messageIndex: 10, expectedSave: 4_000 }] };
    expect(planCostGate(input(noCache)).sweep).toBe(true);
    expect(planCostGate(input({ ...noCache, candidates: [{ id: "a", messageIndex: 10, expectedSave: 3_999 }] })).sweep)
      .toBe(false);
  });

  it("does not sweep with no candidates", () => {
    const plan = planCostGate(input({ candidates: [] }));
    expect(plan.sweep).toBe(false);
    expect(plan.ids).toEqual([]);
  });

  it("respects a stricter margin", () => {
    expect(planCostGate(input({ costMargin: 100 })).sweep).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/cost.test.ts`
Expected: FAIL, cannot resolve `../src/policy/cost.js`.

- [ ] **Step 3: Implement**

`packages/core/src/policy/cost.ts`:

```ts
import type { Prices } from "../types.js";

export interface CostCandidate {
  id: string;
  messageIndex: number;
  expectedSave: number;
}

export interface CostInput {
  candidates: CostCandidate[];
  tokensAfter: (messageIndex: number) => number;
  callsSoFar: number;
  prices: Prices | null;
  costMargin: number;
  noCacheFloor?: number;
}

export interface CostPlan {
  sweep: boolean;
  fromIndex: number;
  ids: string[];
  value: number;
  cost: number;
}

const NONE: CostPlan = { sweep: false, fromIndex: -1, ids: [], value: 0, cost: 0 };

function usableCaching(prices: Prices | null): prices is Prices {
  return prices !== null && prices.cacheRead >= 0 && prices.cacheWrite > prices.cacheRead;
}

export function expectedCalls(callsSoFar: number): number {
  return Math.min(40, Math.max(3, callsSoFar));
}

export function planCostGate(input: CostInput): CostPlan {
  const { candidates, prices, costMargin } = input;
  if (candidates.length === 0) return NONE;

  const sorted = [...candidates].sort((a, b) => a.messageIndex - b.messageIndex);

  // No usable prompt caching: nothing is re-written, so only the size of the
  // saving matters. A quote where writing is no dearer than reading is treated
  // as unusable rather than trusted — a negative `cacheWrite - cacheRead` would
  // make the cost negative and wave every sweep through.
  if (!usableCaching(prices)) {
    const saved = sorted.reduce((sum, candidate) => sum + candidate.expectedSave, 0);
    const floor = input.noCacheFloor ?? 4000;
    return saved >= floor
      ? { sweep: true, fromIndex: sorted[0]!.messageIndex, ids: sorted.map((c) => c.id), value: saved, cost: 0 }
      : NONE;
  }

  const calls = expectedCalls(input.callsSoFar);
  let best: CostPlan = NONE;
  let bestNet = 0;

  for (let start = 0; start < sorted.length; start++) {
    const taken = sorted.slice(start);
    const saved = taken.reduce((sum, candidate) => sum + candidate.expectedSave, 0);
    const fromIndex = taken[0]!.messageIndex;
    const suffix = input.tokensAfter(fromIndex);
    // A saving cannot exceed the suffix it comes out of. If the caller says
    // otherwise its numbers disagree, so believe the smaller one for both
    // sides of the gate rather than crediting a saving that cannot exist.
    const realised = Math.min(saved, Math.max(0, suffix));
    const value = realised * calls * prices.cacheRead;
    const cost = (suffix - realised) * (prices.cacheWrite - prices.cacheRead);
    const net = value - cost;
    if (value >= costMargin * cost && net > bestNet) {
      bestNet = net;
      best = { sweep: true, fromIndex, ids: taken.map((c) => c.id), value, cost };
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/cost.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/policy/cost.ts packages/core/test/cost.test.ts
git commit -m "feat(core): cache-aware cost gate with starting-point selection"
```

---

### Task 8: Jev judgment

**Files:**
- Create: `packages/core/src/judge.ts`
- Test: `packages/core/test/judge.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `Config`, `ResultRef`.
- Produces:
  ```ts
  export interface TaskState {
    recent_user_messages: string[];
    latest_assistant_text: string;
    working_files: string[];
  }
  export interface JevRequest { state: Record<string, unknown>; questions: Record<string, unknown>; model: string; }
  export interface JevClient { systemOne(request: JevRequest, signal?: AbortSignal): Promise<{ answers: Record<string, { noul: number }> }>; }
  export function buildRequest(result: ResultRef, chunks: Chunk[], task: TaskState, afterResult: string, config: Config): JevRequest;
  export function judgeResult(client: JevClient, request: JevRequest, chunkCount: number, config: Config, signal?: AbortSignal): Promise<number[] | null>;
  ```
  `judgeResult` returns `null` on any error, abort, or on exceeding `config.jevBudgetMs`. A missing answer for a chunk counts as 1 (keep it), so a partial response can never drop content.

- [ ] **Step 1: Check the SDK's real exports before writing code against them**

Run:

```bash
npm install @typesafe-ai/sdk -w @token-saver/core
node -e "import('@typesafe-ai/sdk').then(m => console.log(Object.keys(m)))"
```

Expected: a list including `TypeSafeClient` and question helpers (`noul`, `choice`, `score`). Note the actual `noul` signature; if the helper is absent or shaped differently, build the question objects as plain JSON (`{ type: "noul", instructions, criteria }`), which the HTTP API accepts either way. `buildRequest` returns plain JSON objects, so the only place the SDK's shape matters is the adapter in Task 16.

- [ ] **Step 2: Write the failing test**

`packages/core/test/judge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildRequest, judgeResult } from "../src/judge.js";
import type { JevClient, TaskState } from "../src/judge.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Chunk, ResultRef } from "../src/types.js";

const result: ResultRef = {
  id: "call_83", toolName: "read", input: { path: "src/app.ts" },
  text: "", tokens: 9000, messageIndex: 4, turnsAgo: 5, isError: false,
};
const chunks: Chunk[] = [
  { index: 0, startLine: 1, endLine: 20, text: "alpha", tokens: 500 },
  { index: 1, startLine: 21, endLine: 40, text: "beta", tokens: 500 },
];
const task: TaskState = {
  recent_user_messages: ["fix the failing login test"],
  latest_assistant_text: "I'll look at the auth handler",
  working_files: ["src/auth.ts"],
};

describe("buildRequest", () => {
  const request = buildRequest(result, chunks, task, "agent then edited src/auth.ts", DEFAULT_CONFIG);

  it("pins the configured model", () => {
    expect(request.model).toBe("jev-1.13.0");
  });

  it("puts the task, the result, what came after, and the chunks in state", () => {
    expect(request.state).toMatchObject({
      task,
      result: { tool: "read", input: { path: "src/app.ts" } },
      after_result: "agent then edited src/auth.ts",
    });
    expect((request.state.chunks as unknown[]).length).toBe(2);
  });

  it("asks one noul per chunk, keyed by index and referencing that chunk's path", () => {
    expect(Object.keys(request.questions)).toEqual(["chunk::0", "chunk::1"]);
    const first = request.questions["chunk::0"] as { type: string; instructions: string };
    expect(first.type).toBe("noul");
    expect(first.instructions).toContain("`chunks[0]`");
  });

  it("does not send chunk text twice", () => {
    const serialized = JSON.stringify(request.questions);
    expect(serialized).not.toContain("alpha");
  });
});

describe("judgeResult", () => {
  const request = buildRequest(result, chunks, task, "", DEFAULT_CONFIG);

  it("returns one probability per chunk, in index order", async () => {
    const client: JevClient = {
      systemOne: async () => ({ answers: { "chunk::1": { noul: 0.8 }, "chunk::0": { noul: 0.1 } } }),
    };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toEqual([0.1, 0.8]);
  });

  it("keeps a chunk whose answer is missing", async () => {
    const client: JevClient = {
      systemOne: async () => ({ answers: { "chunk::0": { noul: 0.1 } } }),
    };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toEqual([0.1, 1]);
  });

  it("returns null when the client throws", async () => {
    const client: JevClient = { systemOne: async () => { throw new Error("429"); } };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG)).toBeNull();
  });

  it("returns null when the client exceeds the budget", async () => {
    vi.useFakeTimers();
    const client: JevClient = { systemOne: () => new Promise(() => {}) };
    const pending = judgeResult(client, request, 2, { ...DEFAULT_CONFIG, jevBudgetMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeNull();
    vi.useRealTimers();
  });

  it("returns null when the caller's signal is already aborted", async () => {
    const client: JevClient = { systemOne: async () => ({ answers: {} }) };
    expect(await judgeResult(client, request, 2, DEFAULT_CONFIG, AbortSignal.abort())).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/judge.test.ts`
Expected: FAIL, cannot resolve `../src/judge.js`.

- [ ] **Step 4: Implement**

`packages/core/src/judge.ts`:

```ts
import type { Chunk, Config, ResultRef } from "./types.js";

export interface TaskState {
  recent_user_messages: string[];
  latest_assistant_text: string;
  working_files: string[];
}

export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model: string;
}

export interface JevClient {
  systemOne(
    request: JevRequest,
    signal?: AbortSignal,
  ): Promise<{ answers: Record<string, { noul: number }> }>;
}

function instructionsFor(index: number): string {
  return (
    `Given the agent's current task, will it need to look at the text of \`chunks[${index}]\` ` +
    "again to finish, for example because it contains code it will change or call, an error " +
    "it is still fixing, or a value it must reuse?"
  );
}

export function buildRequest(
  result: ResultRef,
  chunks: Chunk[],
  task: TaskState,
  afterResult: string,
  config: Config,
): JevRequest {
  const questions: Record<string, unknown> = {};
  for (const chunk of chunks) {
    questions[`chunk::${chunk.index}`] = {
      type: "noul",
      instructions: instructionsFor(chunk.index),
      criteria: {
        true: "Still needed for work that remains",
        false: "Background already used, or unrelated to what remains",
      },
    };
  }
  return {
    model: config.jevModel,
    state: {
      task,
      result: { tool: result.toolName, input: result.input },
      after_result: afterResult,
      chunks: chunks.map((chunk) => ({ lines: `${chunk.startLine}-${chunk.endLine}`, text: chunk.text })),
    },
    questions,
  };
}

export async function judgeResult(
  client: JevClient,
  request: JevRequest,
  chunkCount: number,
  config: Config,
  signal?: AbortSignal,
): Promise<number[] | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A client that ignores its signal would otherwise hang the sweep, so the
  // budget is a race, not just an abort.
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, config.jevBudgetMs);
  });

  try {
    const response = await Promise.race([client.systemOne(request, controller.signal), budget]);
    if (response === null) return null;
    const probabilities: number[] = [];
    for (let index = 0; index < chunkCount; index++) {
      const answer = response.answers[`chunk::${index}`];
      // A missing OR malformed answer must never drop content. `typeof` alone
      // admits NaN and out-of-range numbers, and both read as "drop" once they
      // meet the keep threshold, so the range is checked here.
      probabilities.push(isProbability(answer?.noul) ? answer.noul : 1);
    }
    return probabilities;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/judge.test.ts`
Expected: PASS, 9 tests. The budget test drives fake timers: `advanceTimersByTimeAsync(60)` fires the budget timer, whose `resolve(null)` wins the race even though the fake client never settles.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/judge.ts packages/core/test/judge.test.ts packages/core/package.json package-lock.json
git commit -m "feat(core): Jev request building and chunk judgment with fail-open"
```

---

### Task 9: The sweep orchestrator and applying decisions

**Files:**
- Create: `packages/core/src/sweep.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/sweep.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces:
  ```ts
  export interface SweepInput {
    results: ResultRef[];
    decided: ReadonlyMap<string, Decision>;
    touches: FileTouch[];
    task: TaskState;
    afterResultFor: (result: ResultRef) => string;
    tokensAfter: (messageIndex: number) => number;
    callsSoFar: number;
    prices: Prices | null;
    config: Config;
    client: JevClient;
    currentTurn: number;
    trigger: "cost" | "context";
    signal?: AbortSignal;
  }
  export interface SweepOutcome { decisions: Decision[]; savedTokens: number; jevRequests: number; jevInputTokens: number; probabilitiesById: Record<string, number[]>; reason: "swept" | "no-candidates" | "gate" | "post-gate" | "judge-failed"; }
  export function runSweep(input: SweepInput): Promise<SweepOutcome>;
  export function applyDecisions<M extends { id: string; text: string }>(results: M[], decided: ReadonlyMap<string, Decision>): M[];
  ```
  `runSweep` never mutates its inputs. The context trigger relaxes eligibility to `minTurnsAgo: 1` and skips the pre-gate, but the post-Jev gate still applies except when `trigger === "context"`.
  `packages/core/src/index.ts` re-exports every public symbol from Tasks 1–9.

- [ ] **Step 1: Write the failing test**

`packages/core/test/sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyDecisions, runSweep } from "../src/sweep.js";
import type { SweepInput } from "../src/sweep.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Decision, ResultRef } from "../src/types.js";
import type { JevClient } from "../src/judge.js";

const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function bigRead(id: string, path: string, messageIndex: number): ResultRef {
  const text = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");
  return {
    id, toolName: "read", input: { path }, text,
    tokens: Math.ceil(text.length / 4), messageIndex, turnsAgo: 6, isError: false,
  };
}

function allStale(): JevClient {
  return { systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.02 };
    return { answers };
  } };
}

function input(over: Partial<SweepInput> = {}): SweepInput {
  const results = over.results ?? [bigRead("a", "src/app.ts", 10), bigRead("b", "src/other.ts", 12)];
  return {
    results,
    decided: new Map(),
    touches: [],
    task: { recent_user_messages: ["go"], latest_assistant_text: "", working_files: [] },
    afterResultFor: () => "",
    // A realistic suffix: the results themselves plus a small tail. The cost gate
    // weighs the saving against what a rewrite re-caches, so an arbitrarily large
    // suffix would make every sweep in these tests look unaffordable.
    tokensAfter: (messageIndex) =>
      results.filter((r) => r.messageIndex >= messageIndex).reduce((sum, r) => sum + r.tokens, 0) + 300,
    callsSoFar: 40,
    prices: PRICES,
    config: DEFAULT_CONFIG,
    client: allStale(),
    currentTurn: 9,
    trigger: "cost",
    ...over,
  };
}

describe("runSweep", () => {
  it("stubs stale results and reports the saving", async () => {
    const outcome = await runSweep(input());
    expect(outcome.reason).toBe("swept");
    expect(outcome.decisions.map((d) => d.level)).toEqual(["stub", "stub"]);
    expect(outcome.savedTokens).toBeGreaterThan(3000);
    expect(outcome.decisions[0]!.rendered).toContain("[token-saver]");
    expect(outcome.decisions[0]!.decidedAtTurn).toBe(9);
    expect(outcome.jevInputTokens).toBeGreaterThan(0);
    expect(Object.keys(outcome.probabilitiesById)).toEqual(["a", "b"]);
  });

  it("stubs a superseded read without calling Jev", async () => {
    let calls = 0;
    const client: JevClient = { systemOne: async () => { calls++; return { answers: {} }; } };
    const outcome = await runSweep(input({
      results: [bigRead("a", "src/app.ts", 10)],
      touches: [{ path: "src/app.ts", messageIndex: 14, kind: "edit" }],
      client,
    }));
    expect(calls).toBe(0);
    expect(outcome.jevRequests).toBe(0);
    expect(outcome.decisions[0]).toMatchObject({ level: "stub", reason: "superseded" });
  });

  it("keeps relevant chunks as a partial", async () => {
    const client: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      Object.keys(request.questions).forEach((key, i) => { answers[key] = { noul: i === 0 ? 0.95 : 0.02 }; });
      return { answers };
    } };
    const outcome = await runSweep(input({ results: [bigRead("a", "src/app.ts", 10)], client }));
    expect(outcome.decisions[0]!.level).toBe("partial");
    expect(outcome.decisions[0]!.rendered).toContain("elided …");
  });

  it("does nothing when the cost gate refuses", async () => {
    const outcome = await runSweep(input({ tokensAfter: () => 900_000, callsSoFar: 3 }));
    expect(outcome.reason).toBe("gate");
    expect(outcome.decisions).toEqual([]);
  });

  it("discards decisions when the real saving fails the gate", async () => {
    // Jev keeps everything, so actual savings are zero and the post-gate refuses.
    const client: JevClient = { systemOne: async (request) => {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
      return { answers };
    } };
    const outcome = await runSweep(input({ client }));
    expect(outcome.reason).toBe("post-gate");
    expect(outcome.decisions).toEqual([]);
  });

  it("changes nothing when Jev fails", async () => {
    const client: JevClient = { systemOne: async () => { throw new Error("boom"); } };
    const outcome = await runSweep(input({ client }));
    expect(outcome.reason).toBe("judge-failed");
    expect(outcome.decisions).toEqual([]);
  });

  it("ignores the pre-gate for the context trigger", async () => {
    const outcome = await runSweep(input({ trigger: "context", tokensAfter: () => 900_000, callsSoFar: 3 }));
    expect(outcome.reason).toBe("swept");
  });

  it("reports no candidates when everything is protected", async () => {
    const outcome = await runSweep(input({ results: [bigRead("a", "src/app.ts", 10)].map((r) => ({ ...r, turnsAgo: 0 })) }));
    expect(outcome.reason).toBe("no-candidates");
  });
});

describe("applyDecisions", () => {
  it("replaces text for stub and partial decisions and leaves the rest", () => {
    const decided = new Map<string, Decision>([
      ["a", { id: "a", level: "stub", rendered: "STUB", savedTokens: 9000, reason: "judged", keptChunks: [], decidedAtTurn: 2 }],
      ["b", { id: "b", level: "leave", rendered: null, savedTokens: 0, reason: "judged", keptChunks: [], decidedAtTurn: 2 }],
    ]);
    const out = applyDecisions([{ id: "a", text: "long" }, { id: "b", text: "keep" }, { id: "c", text: "untouched" }], decided);
    expect(out).toEqual([{ id: "a", text: "STUB" }, { id: "b", text: "keep" }, { id: "c", text: "untouched" }]);
  });

  it("does not mutate its input", () => {
    const messages = [{ id: "a", text: "long" }];
    const decided = new Map<string, Decision>([
      ["a", { id: "a", level: "stub", rendered: "STUB", savedTokens: 1, reason: "judged", keptChunks: [], decidedAtTurn: 1 }],
    ]);
    applyDecisions(messages, decided);
    expect(messages[0]!.text).toBe("long");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/sweep.test.ts`
Expected: FAIL, cannot resolve `../src/sweep.js`.

- [ ] **Step 3: Implement**

`packages/core/src/sweep.ts`:

```ts
import { chunkResult } from "./chunk.js";
import { estimateTokens } from "./tokens.js";
import { buildRequest, judgeResult } from "./judge.js";
import type { JevClient, TaskState } from "./judge.js";
import { decideLevel } from "./policy/decide.js";
import { selectEligible } from "./policy/eligibility.js";
import { findSuperseded } from "./policy/staleness.js";
import type { FileTouch } from "./policy/staleness.js";
import { planCostGate } from "./policy/cost.js";
import { renderPartial, renderStub } from "./render.js";
import type { Config, Decision, Prices, ResultRef } from "./types.js";

export interface SweepInput {
  results: ResultRef[];
  decided: ReadonlyMap<string, Decision>;
  touches: FileTouch[];
  task: TaskState;
  afterResultFor: (result: ResultRef) => string;
  tokensAfter: (messageIndex: number) => number;
  callsSoFar: number;
  prices: Prices | null;
  config: Config;
  client: JevClient;
  currentTurn: number;
  trigger: "cost" | "context";
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
  reason: "swept" | "no-candidates" | "gate" | "post-gate" | "judge-failed";
}

function empty(reason: SweepOutcome["reason"], jevRequests = 0, jevInputTokens = 0): SweepOutcome {
  return { decisions: [], savedTokens: 0, jevRequests, jevInputTokens, probabilitiesById: {}, reason };
}

function firstLineOf(result: ResultRef): number {
  const offset = result.input.offset;
  return typeof offset === "number" && offset > 0 ? offset : 1;
}

export async function runSweep(input: SweepInput): Promise<SweepOutcome> {
  const { config, trigger } = input;
  const eligible = selectEligible(input.results, input.decided, config, {
    minTurnsAgo: trigger === "context" ? 1 : config.protectTurns,
  });
  if (eligible.length === 0) return empty("no-candidates");

  const superseded = findSuperseded(eligible, input.touches);

  if (trigger === "cost") {
    const gate = planCostGate({
      candidates: eligible.map((result) => ({
        id: result.id,
        messageIndex: result.messageIndex,
        expectedSave: superseded.has(result.id)
          ? result.tokens
          : Math.round(result.tokens * config.expectedSaveRatio),
      })),
      tokensAfter: input.tokensAfter,
      callsSoFar: input.callsSoFar,
      prices: input.prices,
      costMargin: config.costMargin,
    });
    if (!gate.sweep) return empty("gate");
    const allowed = new Set(gate.ids);
    eligible.splice(0, eligible.length, ...eligible.filter((result) => allowed.has(result.id)));
  }

  const decisions: Decision[] = [];
  const probabilitiesById: Record<string, number[]> = {};
  let jevRequests = 0;
  let jevInputTokens = 0;

  for (const result of eligible) {
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
    if (probabilities === null) return empty("judge-failed", jevRequests, jevInputTokens);
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

  const savedTokens = decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
  if (decisions.length === 0) return empty("post-gate", jevRequests, jevInputTokens);

  if (trigger === "cost") {
    const postGate = planCostGate({
      candidates: decisions.map((decision) => ({
        id: decision.id,
        messageIndex: input.results.find((r) => r.id === decision.id)!.messageIndex,
        expectedSave: decision.savedTokens,
      })),
      tokensAfter: input.tokensAfter,
      callsSoFar: input.callsSoFar,
      prices: input.prices,
      costMargin: config.costMargin,
    });
    if (!postGate.sweep) return empty("post-gate", jevRequests, jevInputTokens);
  }

  return { decisions, savedTokens, jevRequests, jevInputTokens, probabilitiesById, reason: "swept" };
}

export function applyDecisions<M extends { id: string; text: string }>(
  results: M[],
  decided: ReadonlyMap<string, Decision>,
): M[] {
  return results.map((message) => {
    const decision = decided.get(message.id);
    if (decision === undefined || decision.rendered === null) return message;
    return { ...message, text: decision.rendered };
  });
}
```

`packages/core/src/index.ts`:

```ts
export * from "./types.js";
export * from "./tokens.js";
export * from "./chunk.js";
export * from "./render.js";
export * from "./config.js";
export * from "./judge.js";
export * from "./sweep.js";
export * from "./policy/eligibility.js";
export * from "./policy/staleness.js";
export * from "./policy/decide.js";
export * from "./policy/cost.js";
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/sweep.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole core suite and the type check**

Run: `npx vitest run packages/core && npx tsc -b packages/core`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/sweep.ts packages/core/src/index.ts packages/core/test/sweep.test.ts
git commit -m "feat(core): sweep orchestrator and decision application"
```

---

### Task 10: Configuration loading

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: `Config`, `DEFAULT_CONFIG`.
- Produces: `loadConfig(options?: { files?: string[]; env?: NodeJS.ProcessEnv }): Config`. Precedence: defaults, then each file in order, then env. Unknown keys and unreadable files are ignored. `TOKEN_SAVER=off` sets `enabled: false`. Numeric env keys are `TOKEN_SAVER_` plus the SCREAMING_SNAKE form of the setting name.

- [ ] **Step 1: Write the failing test**

`packages/core/test/config.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

const createdDirs: string[] = [];

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "token-saver-"));
  createdDirs.push(dir);
  const path = join(dir, "token-saver.json");
  writeFileSync(path, contents);
  return path;
}

function fileWith(contents: unknown): string {
  return tempFile(JSON.stringify(contents));
}

function fileWithRaw(contents: string): string {
  return tempFile(contents);
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("returns the defaults with no files or env", () => {
    expect(loadConfig({ files: [], env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("applies files in order, later files winning", () => {
    const config = loadConfig({
      files: [fileWith({ keepThreshold: 0.5 }), fileWith({ keepThreshold: 0.4, protectTurns: 5 })],
      env: {},
    });
    expect(config.keepThreshold).toBe(0.4);
    expect(config.protectTurns).toBe(5);
  });

  it("lets env override files", () => {
    const config = loadConfig({
      files: [fileWith({ keepThreshold: 0.5 })],
      env: { TOKEN_SAVER_KEEP_THRESHOLD: "0.2" },
    });
    expect(config.keepThreshold).toBe(0.2);
  });

  it("treats TOKEN_SAVER=off as disabled", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER: "off" } }).enabled).toBe(false);
    expect(loadConfig({ files: [], env: { TOKEN_SAVER: "on" } }).enabled).toBe(true);
  });

  it("ignores missing files and unknown keys", () => {
    const config = loadConfig({
      files: ["/nope/token-saver.json", fileWith({ nonsense: 1, jevModel: "jev-1.13.0" })],
      env: { TOKEN_SAVER_NONSENSE: "1" },
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("ignores a malformed config file", () => {
    expect(loadConfig({ files: [fileWithRaw("not json {")], env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("ignores non-numeric env values for numeric settings", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_PROTECT_TURNS: "soon" } }).protectTurns).toBe(2);
  });

  it("ignores empty-string env values for numeric settings", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_PROTECT_TURNS: "" } }).protectTurns).toBe(2);
  });

  it("reads excludedTools as a comma-separated env list", () => {
    const config = loadConfig({ files: [], env: { TOKEN_SAVER_EXCLUDED_TOOLS: "edit,write,apply_patch" } });
    expect(config.excludedTools).toEqual(["edit", "write", "apply_patch"]);
  });

  it("ignores empty-string excludedTools", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_EXCLUDED_TOOLS: "" } }).excludedTools).toEqual(["edit", "write"]);
  });

  it("does not alias the default excludedTools array", () => {
    const config = loadConfig({ files: [], env: {} });
    config.excludedTools.push("apply_patch");
    expect(DEFAULT_CONFIG.excludedTools).toEqual(["edit", "write"]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/core/test/config.test.ts`
Expected: FAIL, `loadConfig` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/config.ts` — put the new `import` with the existing one at the top of the file, and the rest below `DEFAULT_CONFIG`:

```ts
import { readFileSync } from "node:fs";

const NUMERIC_KEYS = [
  "minResultTokens", "protectTurns", "keepThreshold", "leaveAloneRatio",
  "minSaving", "costMargin", "contextLevel", "expectedSaveRatio", "jevBudgetMs",
] as const;

function envName(key: string): string {
  return `TOKEN_SAVER_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export function loadConfig(
  options: { files?: string[]; env?: NodeJS.ProcessEnv } = {},
): Config {
  const env = options.env ?? process.env;
  const config: Config = { ...DEFAULT_CONFIG, excludedTools: [...DEFAULT_CONFIG.excludedTools] };

  for (const file of options.files ?? []) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // missing or malformed config must never break a session
    }
    for (const key of NUMERIC_KEYS) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value)) config[key] = value;
    }
    if (typeof parsed.jevModel === "string") config.jevModel = parsed.jevModel;
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
    if (Array.isArray(parsed.excludedTools)) {
      config.excludedTools = parsed.excludedTools.filter((t): t is string => typeof t === "string");
    }
  }

  for (const key of NUMERIC_KEYS) {
    const raw = env[envName(key)];
    if (raw === undefined) continue;
    if (raw.trim() === "") continue; // an empty env value is "not set", never coerced to 0
    const value = Number(raw);
    if (Number.isFinite(value)) config[key] = value;
  }
  const model = env.TOKEN_SAVER_JEV_MODEL;
  if (model !== undefined && model.length > 0) config.jevModel = model;
  const tools = env.TOKEN_SAVER_EXCLUDED_TOOLS;
  if (tools !== undefined && tools.trim() !== "") {
    config.excludedTools = tools.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (env.TOKEN_SAVER === "off") config.enabled = false;

  return config;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/core/test/config.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): load config from files and environment"
```

---

### Task 11: Reading pi sessions

**Files:**
- Create: `packages/replay/package.json`, `packages/replay/tsconfig.json`, `packages/replay/src/session.ts`
- Test: `packages/replay/test/session.test.ts`, `packages/replay/test/fixtures/session.jsonl`

**Interfaces:**
- Consumes: `ResultRef`, `estimateTokens`, `FileTouch`.
- Produces:
  ```ts
  export interface CallSite {
    /** Index of the assistant message that ended this model call. */
    entryIndex: number;
    results: ResultRef[];          // every tool result before this call
    touches: FileTouch[];
    userTurn: number;
    recentUserMessages: string[];
    latestAssistantText: string;
    workingFiles: string[];
    model: string;
    usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  }
  export function parseSession(jsonl: string): CallSite[];
  export function afterResultSummary(site: CallSite, result: ResultRef): string;
  ```
  A call site is produced for every assistant message in the branch. `turnsAgo` on each `ResultRef` is `site.userTurn` minus the turn the result belongs to.

- [ ] **Step 1: Create the package and a small fixture**

`packages/replay/package.json`:

```json
{
  "name": "@token-saver/replay",
  "version": "0.0.0",
  "type": "module",
  "bin": { "token-saver-replay": "./src/cli.ts" },
  "dependencies": { "@token-saver/core": "*" }
}
```

`packages/replay/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/replay/test/fixtures/session.jsonl` (one entry per line; real pi shape, trimmed):

```jsonl
{"type":"session","id":"s1","timestamp":"2026-09-01T10:00:00.000Z"}
{"type":"message","id":"e1","parentId":"s1","timestamp":"2026-09-01T10:00:01.000Z","message":{"role":"user","content":"fix the login test","timestamp":1}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-09-01T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Reading the handler"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"src/auth.ts"}}],"api":"anthropic","provider":"anthropic","model":"claude-sonnet-5","usage":{"input":1000,"output":50,"cacheRead":0,"cacheWrite":1000},"stopReason":"toolUse","timestamp":2}}
{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-09-01T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"export interface Credentials {\n  user: string;\n  pass: string;\n}\n\nexport interface Session {\n  id: string;\n  userId: string;\n  createdAt: number;\n}\n\nconst sessions = new Map<string, Session>();\n\nexport function login(credentials: Credentials): Session {\n  const session: Session = {\n    id: \"sess-\" + Date.now().toString(36),\n    userId: credentials.user,\n    createdAt: Date.now(),\n  };\n  sessions.set(session.id, session);\n  return session;\n}\n\nexport function logout(sessionId: string): void {\n  sessions.delete(sessionId);\n}\n\nexport function sessionFor(sessionId: string): Session | undefined {\n  return sessions.get(sessionId);\n}\n\nexport function rotate(sessionId: string): Session | undefined {\n  const current = sessions.get(sessionId);\n  if (current === undefined) return undefined;\n  const next: Session = { ...current, id: \"sess-\" + Date.now().toString(36), createdAt: Date.now() };\n  sessions.delete(sessionId);\n  sessions.set(next.id, next);\n  return next;\n}\n\nexport function touch(sessionId: string, now = Date.now()): void {\n  const current = sessions.get(sessionId);\n  if (current !== undefined) {\n    current.createdAt = now;\n  }\n}"}],"isError":false,"timestamp":3}}
{"type":"message","id":"e4","parentId":"e3","timestamp":"2026-09-01T10:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Now editing"},{"type":"toolCall","id":"call_2","name":"edit","arguments":{"path":"src/auth.ts"}}],"api":"anthropic","provider":"anthropic","model":"claude-sonnet-5","usage":{"input":2000,"output":40,"cacheRead":1000,"cacheWrite":100},"stopReason":"toolUse","timestamp":4}}
{"type":"message","id":"e5","parentId":"e4","timestamp":"2026-09-01T10:00:05.000Z","message":{"role":"toolResult","toolCallId":"call_2","toolName":"edit","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":5}}
{"type":"message","id":"e6","parentId":"e5","timestamp":"2026-09-01T10:00:06.000Z","message":{"role":"user","content":"now run the tests","timestamp":6}}
{"type":"message","id":"e7","parentId":"e6","timestamp":"2026-09-01T10:00:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Running"}],"api":"anthropic","provider":"anthropic","model":"claude-sonnet-5","usage":{"input":3000,"output":30,"cacheRead":2000,"cacheWrite":100},"stopReason":"stop","timestamp":7}}
```

- [ ] **Step 2: Write the failing test**

`packages/replay/test/session.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { afterResultSummary, parseSession } from "../src/session.js";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");

describe("parseSession", () => {
  const sites = parseSession(jsonl);

  it("makes one call site per assistant message", () => {
    expect(sites).toHaveLength(3);
  });

  it("carries the tool results available before each call", () => {
    expect(sites[0]!.results).toHaveLength(0);
    expect(sites[1]!.results.map((r) => r.id)).toEqual(["call_1"]);
    expect(sites[2]!.results.map((r) => r.id)).toEqual(["call_1", "call_2"]);
  });

  it("joins text blocks and estimates tokens for a result", () => {
    const result = sites[1]!.results[0]!;
    expect(result.text).toContain("export function login");
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.toolName).toBe("read");
    expect(result.input).toEqual({ path: "src/auth.ts" });
  });

  it("counts user turns and turnsAgo", () => {
    expect(sites[1]!.userTurn).toBe(1);
    expect(sites[2]!.userTurn).toBe(2);
    expect(sites[2]!.results[0]!.turnsAgo).toBe(1);
  });

  it("records file touches from read, edit and write calls", () => {
    expect(sites[2]!.touches).toEqual([
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "read" },
      { path: "src/auth.ts", messageIndex: expect.any(Number), kind: "edit" },
    ]);
  });

  it("collects task state for the judgment", () => {
    expect(sites[2]!.recentUserMessages).toEqual(["fix the login test", "now run the tests"]);
    expect(sites[2]!.latestAssistantText).toBe("Now editing");
    expect(sites[2]!.workingFiles).toContain("src/auth.ts");
  });

  it("keeps the model and usage of each call", () => {
    expect(sites[2]!.model).toBe("claude-sonnet-5");
    expect(sites[2]!.usage.cacheRead).toBe(2000);
  });
});

describe("afterResultSummary", () => {
  it("describes what the agent did after the result", () => {
    const sites = parseSession(jsonl);
    const summary = afterResultSummary(sites[2]!, sites[2]!.results[0]!);
    expect(summary).toContain("edit");
    expect(summary).toContain("src/auth.ts");
  });

  it("is empty when nothing followed", () => {
    const sites = parseSession(jsonl);
    expect(afterResultSummary(sites[1]!, sites[1]!.results[0]!)).toBe("");
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run packages/replay/test/session.test.ts`
Expected: FAIL, cannot resolve `../src/session.js`.

- [ ] **Step 4: Implement**

`packages/replay/src/session.ts`:

```ts
import { estimateTokens } from "@token-saver/core";
import type { FileTouch, ResultRef } from "@token-saver/core";

interface Entry {
  type: string;
  id: string;
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    model?: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
}

export interface CallSite {
  entryIndex: number;
  results: ResultRef[];
  touches: FileTouch[];
  userTurn: number;
  recentUserMessages: string[];
  latestAssistantText: string;
  workingFiles: string[];
  model: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

const TOUCH_KIND: Record<string, FileTouch["kind"]> = { read: "read", edit: "edit", write: "write" };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function pathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function parseSession(jsonl: string): CallSite[] {
  const entries: Entry[] = jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Entry);

  const sites: CallSite[] = [];
  const results: ResultRef[] = [];
  const touches: FileTouch[] = [];
  const userMessages: string[] = [];
  const callsById = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  let userTurn = 0;
  let latestAssistantText = "";
  let messageIndex = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message === undefined) continue;
    const message = entry.message;
    messageIndex++;

    if (message.role === "user") {
      userTurn++;
      userMessages.push(textOf(message.content));
      continue;
    }

    if (message.role === "toolResult") {
      const call = callsById.get(message.toolCallId ?? "");
      const text = textOf(message.content);
      results.push({
        id: message.toolCallId ?? `unknown_${messageIndex}`,
        toolName: message.toolName ?? call?.name ?? "unknown",
        input: call?.args ?? {},
        text,
        tokens: estimateTokens(text),
        messageIndex,
        turnsAgo: 0, // filled per call site below
        isError: message.isError === true,
      });
      continue;
    }

    if (message.role !== "assistant") continue;

    // A call site is the context as it stood when the model was asked to produce
    // THIS message, so it is recorded before this message's own tool calls are.
    const workingFiles = [...new Set(
      touches.filter((t) => t.kind !== "read").map((t) => t.path),
    )];

    sites.push({
      entryIndex: messageIndex,
      results: results.map((result) => ({
        ...result,
        turnsAgo: userTurn - (callsById.get(result.id)?.turn ?? userTurn),
      })),
      touches: [...touches],
      userTurn,
      recentUserMessages: [...userMessages],
      latestAssistantText,
      workingFiles,
      model: message.model ?? "unknown",
      usage: message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    latestAssistantText = textOf(message.content);

    for (const block of Array.isArray(message.content) ? message.content : []) {
      const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
      if (call.type !== "toolCall" || call.id === undefined || call.name === undefined) continue;
      const args = call.arguments ?? {};
      callsById.set(call.id, { name: call.name, args, turn: userTurn });
      const kind = TOUCH_KIND[call.name];
      const path = pathArg(args);
      if (kind !== undefined && path !== null) touches.push({ path, messageIndex, kind });
    }
  }

  return sites;
}

export function afterResultSummary(site: CallSite, result: ResultRef): string {
  const later = site.touches.filter((touch) => touch.messageIndex > result.messageIndex);
  if (later.length === 0) return "";
  return later.map((touch) => `${touch.kind} ${touch.path}`).join("; ");
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run packages/replay/test/session.test.ts`
Expected: PASS, 9 tests. Note `latestAssistantText` is the text of the *previous* assistant message, and a site's `touches` exclude the calls made in its own message — both because the model call being replayed has not happened yet.

- [ ] **Step 6: Commit**

```bash
git add packages/replay package-lock.json
git commit -m "feat(replay): parse pi sessions into call sites"
```

---

### Task 12: Retention (miss detection)

**Files:**
- Create: `packages/replay/src/retention.ts`
- Test: `packages/replay/test/retention.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `CallSite`.
- Produces:
  ```ts
  export interface LaterUse { text: string; kind: "assistant" | "edit" | "command"; }
  export interface Miss { resultId: string; chunkIndex: number; probability: number; evidence: LaterUse["kind"]; }
  export function collectLaterUses(jsonl: string, afterMessageIndex: number): LaterUse[];
  export function detectMisses(resultId: string, chunks: Chunk[], probabilities: number[], elided: number[], laterUses: LaterUse[]): Miss[];
  ```
  A chunk counts as used when one of its lines, trimmed and at least 12 characters long, appears verbatim in later assistant text, in a later edit's arguments, or in a later command.

- [ ] **Step 1: Write the failing test**

`packages/replay/test/retention.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectLaterUses, detectMisses } from "../src/retention.js";
import type { Chunk } from "@token-saver/core";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");

function chunk(index: number, lines: string[]): Chunk {
  return { index, startLine: index * 10 + 1, endLine: index * 10 + lines.length, text: lines.join("\n"), tokens: 40 };
}

describe("collectLaterUses", () => {
  it("collects assistant text and tool arguments after a point", () => {
    const uses = collectLaterUses(jsonl, 3);
    expect(uses.some((use) => use.kind === "assistant" && use.text.includes("Now editing"))).toBe(true);
    expect(uses.some((use) => use.text.includes("src/auth.ts"))).toBe(true);
  });

  it("returns nothing for a point past the end", () => {
    expect(collectLaterUses(jsonl, 999)).toEqual([]);
  });
});

describe("detectMisses", () => {
  const chunks = [
    chunk(0, ["export function login(credentials) {", "  return session.create(credentials);"]),
    chunk(1, ["const unrelatedHelper = 42;"]),
  ];

  it("reports an elided chunk whose line the agent later used", () => {
    const misses = detectMisses("call_1", chunks, [0.1, 0.05], [0, 1], [
      { text: "return session.create(credentials); is wrong here", kind: "assistant" },
    ]);
    expect(misses).toEqual([{ resultId: "call_1", chunkIndex: 0, probability: 0.1, evidence: "assistant" }]);
  });

  it("ignores chunks that were kept", () => {
    const misses = detectMisses("call_1", chunks, [0.9, 0.05], [1], [
      { text: "return session.create(credentials);", kind: "assistant" },
    ]);
    expect(misses).toEqual([]);
  });

  it("ignores short lines that would match by accident", () => {
    const short = [chunk(0, ["}", "x = 1"])];
    const misses = detectMisses("call_1", short, [0.01], [0], [{ text: "}", kind: "assistant" }]);
    expect(misses).toEqual([]);
  });

  it("matches edits and commands too", () => {
    const misses = detectMisses("call_1", chunks, [0.01, 0.01], [0, 1], [
      { text: "const unrelatedHelper = 42;", kind: "edit" },
    ]);
    expect(misses.map((miss) => miss.evidence)).toEqual(["edit"]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/replay/test/retention.test.ts`
Expected: FAIL, cannot resolve `../src/retention.js`.

- [ ] **Step 3: Implement**

`packages/replay/src/retention.ts`:

```ts
import type { Chunk } from "@token-saver/core";

export interface LaterUse {
  text: string;
  kind: "assistant" | "edit" | "command";
}

export interface Miss {
  resultId: string;
  chunkIndex: number;
  probability: number;
  evidence: LaterUse["kind"];
}

const MIN_LINE = 12;

export function collectLaterUses(jsonl: string, afterMessageIndex: number): LaterUse[] {
  const uses: LaterUse[] = [];
  let messageIndex = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as { type: string; message?: { role: string; content?: unknown } };
    if (entry.type !== "message" || entry.message === undefined) continue;
    messageIndex++;
    if (messageIndex <= afterMessageIndex) continue;
    if (entry.message.role !== "assistant") continue;

    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        uses.push({ text: typed.text, kind: "assistant" });
      } else if (typed.type === "toolCall") {
        uses.push({
          text: JSON.stringify(typed.arguments ?? {}),
          kind: typed.name === "bash" ? "command" : "edit",
        });
      }
    }
  }
  return uses;
}

export function detectMisses(
  resultId: string,
  chunks: Chunk[],
  probabilities: number[],
  elided: number[],
  laterUses: LaterUse[],
): Miss[] {
  const misses: Miss[] = [];
  for (const index of elided) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const lines = chunk.text.split("\n").map((line) => line.trim()).filter((line) => line.length >= MIN_LINE);
    const hit = laterUses.find((use) => lines.some((line) => use.text.includes(line)));
    if (hit !== undefined) {
      misses.push({ resultId, chunkIndex: index, probability: probabilities[index] ?? 0, evidence: hit.kind });
    }
  }
  return misses;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/replay/test/retention.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/replay/src/retention.ts packages/replay/test/retention.test.ts
git commit -m "feat(replay): detect elided chunks the agent later used"
```

---

### Task 13: The replay runner and the Jev answer cache

**Files:**
- Create: `packages/replay/src/jevCache.ts`, `packages/replay/src/run.ts`
- Test: `packages/replay/test/run.test.ts`

**Interfaces:**
- Consumes: `runSweep`, `applyDecisions`, `CallSite`, `detectMisses`, `collectLaterUses`.
- Produces:
  ```ts
  export function cachingClient(client: JevClient, cachePath: string): JevClient;   // jevCache.ts
  export interface ReplayMetrics {
    session: string; calls: number;
    tokensBefore: number; tokensAfter: number;
    sweeps: number; stubbed: number; partial: number;
    jevRequests: number; jevInputTokens: number;
    rewrittenTokens: number;   // suffix re-written to cache by sweeps
    sweepMs: number;           // wall-clock spent in sweeps
    misses: Miss[];
  }
  export function replaySession(jsonl: string, name: string, client: JevClient, config: Config, prices: Prices | null): Promise<ReplayMetrics>;
  ```
  `tokensBefore`/`tokensAfter` are the sum, over call sites, of the tool-result tokens in that call's context, without and with decisions applied. One price table is used for the whole session rather than each call's own model prices: sessions rarely switch models, and the cost gate's behaviour, not its exact dollars, is what replay is tuning.

- [ ] **Step 1: Write the failing test**

`packages/replay/test/run.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { cachingClient } from "../src/jevCache.js";
import { replaySession } from "../src/run.js";

const jsonl = readFileSync(join(import.meta.dirname, "fixtures/session.jsonl"), "utf8");
const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

const stale: JevClient = {
  systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.01 };
    return { answers };
  },
};

describe("cachingClient", () => {
  it("calls through once and replays from disk afterwards", async () => {
    let calls = 0;
    const counted: JevClient = { systemOne: async () => { calls++; return { answers: { "chunk::0": { noul: 0.5 } } }; } };
    const path = join(mkdtempSync(join(tmpdir(), "ts-cache-")), "jev.json");
    const request = { state: { a: 1 }, questions: { "chunk::0": {} }, model: "jev-1.13.0" };

    const first = await cachingClient(counted, path).systemOne(request);
    const second = await cachingClient(counted, path).systemOne(request);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});

describe("replaySession", () => {
  it("reports per-session token counts and sweep activity", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, {
      ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0,
    }, PRICES);
    expect(metrics.session).toBe("fixture");
    expect(metrics.calls).toBe(3);
    expect(metrics.tokensBefore).toBeGreaterThan(0);
    expect(metrics.tokensAfter).toBeLessThanOrEqual(metrics.tokensBefore);
  });

  it("changes nothing when the extension is configured off", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, { ...DEFAULT_CONFIG, enabled: false }, PRICES);
    expect(metrics.tokensAfter).toBe(metrics.tokensBefore);
    expect(metrics.sweeps).toBe(0);
  });

  it("never lets a decision change after it is taken", async () => {
    const metrics = await replaySession(jsonl, "fixture", stale, {
      ...DEFAULT_CONFIG, minResultTokens: 1, protectTurns: 0, minSaving: 0,
    }, PRICES);
    // Each result is decided at most once: sweeps never exceed the number of results.
    expect(metrics.stubbed + metrics.partial).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/replay/test/run.test.ts`
Expected: FAIL, cannot resolve `../src/jevCache.js`.

- [ ] **Step 3: Implement the cache**

`packages/replay/src/jevCache.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevClient, JevRequest } from "@token-saver/core";

type Answers = { answers: Record<string, { noul: number }> };

function keyOf(request: JevRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function cachingClient(client: JevClient, cachePath: string): JevClient {
  const load = (): Record<string, Answers> => {
    try {
      return JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, Answers>;
    } catch {
      return {};
    }
  };

  return {
    async systemOne(request, signal) {
      const cache = load();
      const key = keyOf(request);
      const hit = cache[key];
      if (hit !== undefined) return hit;

      const answer = await client.systemOne(request, signal);
      cache[key] = answer;
      if (!existsSync(dirname(cachePath))) mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(cache));
      return answer;
    },
  };
}
```

- [ ] **Step 4: Implement the runner**

`packages/replay/src/run.ts`:

```ts
import { applyDecisions, chunkResult, runSweep } from "@token-saver/core";
import type { Config, Decision, JevClient, Prices } from "@token-saver/core";
import { afterResultSummary, parseSession } from "./session.js";
import { collectLaterUses, detectMisses } from "./retention.js";
import type { Miss } from "./retention.js";

export interface ReplayMetrics {
  session: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  sweeps: number;
  stubbed: number;
  partial: number;
  jevRequests: number;
  jevInputTokens: number;
  /** Tokens re-written to cache because a sweep changed the history before them. */
  rewrittenTokens: number;
  sweepMs: number;
  misses: Miss[];
}

export async function replaySession(
  jsonl: string,
  name: string,
  client: JevClient,
  config: Config,
  prices: Prices | null,
): Promise<ReplayMetrics> {
  const sites = parseSession(jsonl);
  const decided = new Map<string, Decision>();
  const metrics: ReplayMetrics = {
    session: name, calls: sites.length, tokensBefore: 0, tokensAfter: 0,
    sweeps: 0, stubbed: 0, partial: 0, jevRequests: 0, jevInputTokens: 0,
    rewrittenTokens: 0, sweepMs: 0, misses: [],
  };

  for (const [callIndex, site] of sites.entries()) {
    const before = site.results.reduce((sum, result) => sum + result.tokens, 0);
    metrics.tokensBefore += before;

    if (config.enabled) {
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
        tokensAfter: (messageIndex) =>
          site.results
            .filter((result) => result.messageIndex >= messageIndex)
            .reduce((sum, result) => sum + result.tokens, 0),
        callsSoFar: callIndex + 1,
        prices,
        config,
        client,
        currentTurn: site.userTurn,
        trigger: "cost",
      });
      metrics.sweepMs += Date.now() - startedAt;
      metrics.jevRequests += outcome.jevRequests;
      metrics.jevInputTokens += outcome.jevInputTokens;

      if (outcome.decisions.length > 0) {
        metrics.sweeps++;
        const fromIndex = Math.min(
          ...outcome.decisions.map(
            (decision) => site.results.find((result) => result.id === decision.id)!.messageIndex,
          ),
        );
        metrics.rewrittenTokens += site.results
          .filter((result) => result.messageIndex >= fromIndex)
          .reduce((sum, result) => sum + result.tokens, 0);

        for (const decision of outcome.decisions) {
          decided.set(decision.id, decision);
          if (decision.level === "stub") metrics.stubbed++;
          if (decision.level === "partial") metrics.partial++;

          const result = site.results.find((candidate) => candidate.id === decision.id)!;
          const chunks = chunkResult(result.toolName, result.text);
          const elided = chunks
            .map((chunk) => chunk.index)
            .filter((index) => !decision.keptChunks.includes(index));
          metrics.misses.push(
            ...detectMisses(
              decision.id,
              chunks,
              outcome.probabilitiesById[decision.id] ?? [],
              elided,
              collectLaterUses(jsonl, result.messageIndex),
            ),
          );
        }
      }
    }

    const applied = applyDecisions(
      site.results.map((result) => ({ id: result.id, text: result.text, tokens: result.tokens })),
      decided,
    );
    metrics.tokensAfter += applied.reduce(
      (sum, message) => sum + Math.ceil(message.text.length / 4),
      0,
    );
  }

  return metrics;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run packages/replay/test/run.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/replay/src/jevCache.ts packages/replay/src/run.ts packages/replay/test/run.test.ts
git commit -m "feat(replay): session runner with cached Jev answers and miss tracking"
```

---

### Task 14: The replay CLI and report

**Files:**
- Create: `packages/replay/src/report.ts`, `packages/replay/src/args.ts`, `packages/replay/src/cli.ts`
- Test: `packages/replay/test/report.test.ts`, `packages/replay/test/args.test.ts`

**Interfaces:**
- Consumes: `ReplayMetrics`.
- Produces:
  ```ts
  export interface TauRun { tau: number; metrics: ReplayMetrics[]; }
  export const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;
  export function summarize(metrics: ReplayMetrics[], prices?: Prices): {
    tokensBefore: number; tokensAfter: number; savedPct: number;
    sweeps: number; stubbed: number; partial: number; misses: number;
    jevRequests: number; jevUsd: number; rewrittenTokens: number; sweepMs: number;
    /** cache-read saved minus cache-write paid minus Jev spend, in dollars. */
    netUsd: number;
  };
  export function renderReport(runs: TauRun[]): string;   // markdown, one row per tau
  ```
  CLI: `token-saver-replay <sessions-dir-or-file...> [--tau 0.1,0.3] [--report out/]`. It writes `out/report.md` and `out/metrics.json`, caches Jev answers in `out/jev-cache.json`, and prints the summary table.

- [ ] **Step 1: Write the failing test**

`packages/replay/test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderReport, summarize } from "../src/report.js";
import type { ReplayMetrics } from "../src/run.js";

function metrics(over: Partial<ReplayMetrics> = {}): ReplayMetrics {
  return {
    session: "s", calls: 10, tokensBefore: 100_000, tokensAfter: 60_000,
    sweeps: 2, stubbed: 3, partial: 1, jevRequests: 5, jevInputTokens: 20_000,
    rewrittenTokens: 50_000, sweepMs: 300, misses: [], ...over,
  };
}

describe("summarize", () => {
  it("totals the sessions and computes the saved percentage", () => {
    const total = summarize([metrics(), metrics({ tokensBefore: 100_000, tokensAfter: 80_000 })]);
    expect(total.tokensBefore).toBe(200_000);
    expect(total.tokensAfter).toBe(140_000);
    expect(total.savedPct).toBeCloseTo(30, 5);
  });

  it("counts misses across sessions", () => {
    const total = summarize([
      metrics({ misses: [{ resultId: "a", chunkIndex: 0, probability: 0.1, evidence: "assistant" }] }),
      metrics(),
    ]);
    expect(total.misses).toBe(1);
  });

  it("reports zero savings for an empty run", () => {
    expect(summarize([]).savedPct).toBe(0);
    expect(summarize([]).netUsd).toBe(0);
  });

  it("nets cache reads avoided against cache writes paid and Jev spend", () => {
    const prices = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
    const total = summarize([metrics()], prices);
    expect(total.jevUsd).toBeCloseTo(20_000 * (0.042 / 1e6), 10);
    // 40k tokens saved at cacheRead, 50k rewritten at cacheWrite: a net loss here.
    expect(total.netUsd).toBeCloseTo(
      40_000 * prices.cacheRead - 50_000 * prices.cacheWrite - total.jevUsd,
      10,
    );
    expect(total.netUsd).toBeLessThan(0);
  });
});

describe("renderReport", () => {
  it("writes one markdown row per tau with savings and misses", () => {
    const report = renderReport([
      { tau: 0.1, metrics: [metrics()] },
      { tau: 0.3, metrics: [metrics({ tokensAfter: 50_000, misses: [{ resultId: "a", chunkIndex: 1, probability: 0.2, evidence: "edit" }] })] },
    ]);
    expect(report).toContain("| tau |");
    expect(report).toContain("| 0.1 |");
    expect(report).toContain("| 0.3 |");
    expect(report).toMatch(/40\.0%/);
    expect(report).toContain("| net $ |");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/replay/test/report.test.ts`
Expected: FAIL, cannot resolve `../src/report.js`.

- [ ] **Step 3: Implement the report**

`packages/replay/src/report.ts`:

```ts
import type { Prices } from "@token-saver/core";
import type { ReplayMetrics } from "./run.js";

export interface TauRun {
  tau: number;
  metrics: ReplayMetrics[];
}

export const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

/** Anthropic-shaped defaults, per token. */
const DEFAULT_PRICES: Prices = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

export function summarize(all: ReplayMetrics[], prices: Prices = DEFAULT_PRICES) {
  const total = all.reduce(
    (sum, metrics) => ({
      tokensBefore: sum.tokensBefore + metrics.tokensBefore,
      tokensAfter: sum.tokensAfter + metrics.tokensAfter,
      sweeps: sum.sweeps + metrics.sweeps,
      stubbed: sum.stubbed + metrics.stubbed,
      partial: sum.partial + metrics.partial,
      misses: sum.misses + metrics.misses.length,
      jevRequests: sum.jevRequests + metrics.jevRequests,
      jevInputTokens: sum.jevInputTokens + metrics.jevInputTokens,
      rewrittenTokens: sum.rewrittenTokens + metrics.rewrittenTokens,
      sweepMs: sum.sweepMs + metrics.sweepMs,
    }),
    {
      tokensBefore: 0, tokensAfter: 0, sweeps: 0, stubbed: 0, partial: 0,
      misses: 0, jevRequests: 0, jevInputTokens: 0, rewrittenTokens: 0, sweepMs: 0,
    },
  );
  const savedPct = total.tokensBefore === 0
    ? 0
    : ((total.tokensBefore - total.tokensAfter) / total.tokensBefore) * 100;

  // Tokens are already summed over every model call, so the saving is cumulative
  // cache reads avoided. Each sweep pays cacheWrite once for the suffix it moved.
  const jevUsd = total.jevInputTokens * JEV_PRICE_PER_TOKEN;
  const netUsd =
    (total.tokensBefore - total.tokensAfter) * prices.cacheRead -
    total.rewrittenTokens * prices.cacheWrite -
    jevUsd;

  return { ...total, savedPct, jevUsd, netUsd };
}

export function renderReport(runs: TauRun[]): string {
  const lines = [
    "# token-saver replay",
    "",
    "| tau | tokens before | tokens after | saved | sweeps | stubbed | partial | misses | jev reqs | jev $ | net $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of runs) {
    const s = summarize(run.metrics);
    lines.push(
      `| ${run.tau} | ${s.tokensBefore.toLocaleString()} | ${s.tokensAfter.toLocaleString()} | ` +
      `${s.savedPct.toFixed(1)}% | ${s.sweeps} | ${s.stubbed} | ${s.partial} | ${s.misses} | ` +
      `${s.jevRequests} | ${s.jevUsd.toFixed(4)} | ${s.netUsd.toFixed(4)} |`,
    );
  }
  lines.push("", "A miss is an elided chunk whose text the agent used later: it would have cost a recall.");
  lines.push("", "Net $ is cache reads avoided minus cache writes paid minus Jev spend, at Anthropic prices.");
  return lines.join("\n");
}
```

- [ ] **Step 4: Implement the arg parser and the CLI**

`packages/replay/src/args.ts`:

```ts
export interface CliArgs {
  targets: string[];
  tau: number[];
  report: string;
}

/** Parse positional session targets plus the --tau and --report flags,
 * consuming each flag's value as a pair so a value like "out/" is never
 * mistaken for a session path. */
export function parseArgs(argv: string[]): CliArgs {
  const targets: string[] = [];
  let tau = [0.3];
  let report = "out";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tau") {
      tau = (argv[++i] ?? "0.3").split(",").map(Number);
      continue;
    }
    if (arg === "--report") {
      report = argv[++i] ?? "out";
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    targets.push(arg);
  }
  return { targets, tau, report };
}
```

`packages/replay/src/cli.ts`:

```ts
#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient, JevRequest } from "@token-saver/core";
import { parseArgs } from "./args.js";
import { cachingClient } from "./jevCache.js";
import { replaySession } from "./run.js";
import { DEFAULT_PRICES, renderReport, summarize } from "./report.js";
import type { TauRun } from "./report.js";

function httpClient(): JevClient {
  const key = process.env.TYPESAFE_API_KEY;
  return {
    async systemOne(request: JevRequest, signal?: AbortSignal) {
      if (key === undefined) throw new Error("TYPESAFE_API_KEY is not set");
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(`typesafe ${response.status}`);
      return (await response.json()) as { answers: Record<string, { noul: number }> };
    },
  };
}

function sessionFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(target, name));
}

const { targets, tau: taus, report: outDir } = parseArgs(process.argv.slice(2));

mkdirSync(outDir, { recursive: true });
const client = cachingClient(httpClient(), join(outDir, "jev-cache.json"));
const files = targets.flatMap(sessionFiles);
const runs: TauRun[] = [];

for (const tau of taus) {
  const metrics = [];
  for (const file of files) {
    metrics.push(
      await replaySession(
        readFileSync(file, "utf8"),
        file,
        client,
        { ...DEFAULT_CONFIG, keepThreshold: tau },
        DEFAULT_PRICES,
      ),
    );
  }
  runs.push({ tau, metrics });
  const summary = summarize(metrics);
  console.log(
    `tau ${tau}: saved ${summary.savedPct.toFixed(1)}%, ${summary.misses} misses, ` +
    `net $${summary.netUsd.toFixed(4)} (jev $${summary.jevUsd.toFixed(4)})`,
  );
}

writeFileSync(join(outDir, "report.md"), renderReport(runs));
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(runs, null, 2));
console.log(`\nwrote ${join(outDir, "report.md")}`);
```

- [ ] **Step 5: Run the tests and the CLI against the fixture**

Run: `npx vitest run packages/replay`
Expected: PASS, all replay tests.

Run: `npx tsx packages/replay/src/cli.ts packages/replay/test/fixtures/session.jsonl --report /tmp/ts-out`
Expected: a `tau 0.3: saved ...` line and `/tmp/ts-out/report.md`. With no `TYPESAFE_API_KEY` the fixture is too small to trigger a sweep, so it should still complete. Install `tsx` as a dev dependency if it is missing.

- [ ] **Step 6: Commit**

```bash
git add packages/replay/src/report.ts packages/replay/src/cli.ts packages/replay/test/report.test.ts package.json package-lock.json
git commit -m "feat(replay): CLI and markdown report with tau curve"
```

---

### Task 15: Run replay on the real sessions and set the defaults

**Files:**
- Create: `docs/superpowers/notes/replay-baseline.md`
- Modify: `packages/core/src/config.ts` (only if the data says the defaults are wrong)

**Interfaces:**
- Consumes: the replay CLI.
- Produces: a recorded baseline and, if warranted, revised defaults. No new code interfaces.

**Execution note (controller ruling):** `TYPESAFE_API_KEY` is not set in this
environment and Jev cannot be reached, so Step 1 cannot run here. Do Steps 2–5
as follows instead: write the note file with a "Not yet run" section holding the
exact command below, the session directory, and the tau values to try; leave
`DEFAULT_CONFIG.keepThreshold` at 0.3 and do not touch `config.ts`; run
`npx vitest run` and commit. Do not fabricate a table. If the key IS present in
your environment (`echo "${TYPESAFE_API_KEY:+set}"` prints `set`), run Step 1 for
real and do the task as written.

- [ ] **Step 1: Run replay over the real session history**

Run:

```bash
export TYPESAFE_API_KEY=...   # ask the user; never commit it
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions --tau 0.1,0.2,0.3,0.5 --report out/baseline
```

Expected: a table with one row per tau. Jev spend should be cents at most; stop and report if it is not.

- [ ] **Step 2: Write down what the run showed**

Create `docs/superpowers/notes/replay-baseline.md` containing the date of the run, the report table, the number of sessions and calls, and the misses per tau with their probabilities.

- [ ] **Step 3: Pick `keepThreshold` from the curve**

Choose the largest tau whose miss count stays at zero, or, if every tau misses, the tau where misses stop falling as savings rise. Change `DEFAULT_CONFIG.keepThreshold` only if the chosen value differs from 0.3, and say so in the note.

- [ ] **Step 4: Re-run the core tests**

Run: `npx vitest run`
Expected: PASS. `decide.test.ts` asserts against `DEFAULT_CONFIG`, so a changed default may need the test's expectations updated — update the test, not the assertions' intent.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes packages/core/src/config.ts packages/core/test/decide.test.ts
git commit -m "docs: replay baseline over recorded sessions, tune keepThreshold"
```

---

### Task 16: The pi extension skeleton: config, state, and applying decisions

**Files:**
- Create: `packages/pi/package.json`, `packages/pi/tsconfig.json`, `packages/pi/build.mjs`, `packages/pi/src/state.ts`, `packages/pi/src/jev.ts`
- Test: `packages/pi/test/state.test.ts`

**Interfaces:**
- Consumes: `Decision`, `SweepEntryData`, `loadConfig`, `JevClient`.
- Produces:
  ```ts
  // state.ts
  export class DecisionStore {
    constructor();
    get(): ReadonlyMap<string, Decision>;
    add(decisions: Decision[]): void;
    rebuildFrom(entries: Array<{ type: string; customType?: string; data?: unknown }>): void;  // ignores everything before the last compaction
    remove(id: string): boolean;
    stats(): { stubbed: number; partial: number; savedTokens: number };
  }
  export const SWEEP_ENTRY = "token-saver/sweep";
  // jev.ts
  export function sdkClient(apiKey: string | undefined): JevClient | null;   // null when no key
  ```

- [ ] **Step 1: Create the package**

`packages/pi/package.json`:

```json
{
  "name": "@token-saver/pi",
  "version": "0.0.0",
  "type": "module",
  "scripts": { "build": "node build.mjs" },
  "dependencies": { "@token-saver/core": "*" },
  "devDependencies": { "esbuild": "^0.24.0", "@earendil-works/pi-coding-agent": "^0.85.1" }
}
```

`packages/pi/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

`packages/pi/build.mjs`:

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/token-saver.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@earendil-works/*"],
});
console.log("wrote packages/pi/dist/token-saver.js");
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`packages/pi/test/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DecisionStore, SWEEP_ENTRY } from "../src/state.js";
import type { Decision } from "@token-saver/core";

function decision(id: string, level: Decision["level"] = "stub"): Decision {
  return {
    id, level, rendered: level === "leave" ? null : `[token-saver] ${id}`,
    savedTokens: 1000, reason: "judged", keptChunks: [], decidedAtTurn: 1,
  };
}

describe("DecisionStore", () => {
  it("starts empty", () => {
    expect(new DecisionStore().get().size).toBe(0);
  });

  it("adds decisions and reports statistics", () => {
    const store = new DecisionStore();
    store.add([decision("a"), decision("b", "partial")]);
    expect(store.get().size).toBe(2);
    expect(store.stats()).toEqual({ stubbed: 1, partial: 1, savedTokens: 2000 });
  });

  it("never lets a later decision overwrite an existing one", () => {
    const store = new DecisionStore();
    store.add([decision("a")]);
    store.add([{ ...decision("a", "partial"), savedTokens: 99 }]);
    expect(store.get().get("a")!.level).toBe("stub");
    expect(store.stats().savedTokens).toBe(1000);
  });

  it("rebuilds from session entries, ignoring other custom types", () => {
    const store = new DecisionStore();
    store.rebuildFrom([
      { type: "custom", customType: "other", data: { decisions: [decision("z")] } },
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("a")], trigger: "cost", at: "t" } },
      { type: "message" },
    ]);
    expect([...store.get().keys()]).toEqual(["a"]);
  });

  it("drops decisions taken before the last compaction", () => {
    const store = new DecisionStore();
    store.rebuildFrom([
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("old")] } },
      { type: "compaction" },
      { type: "custom", customType: SWEEP_ENTRY, data: { decisions: [decision("fresh")] } },
    ]);
    expect([...store.get().keys()]).toEqual(["fresh"]);
  });

  it("survives malformed entry data", () => {
    const store = new DecisionStore();
    store.rebuildFrom([{ type: "custom", customType: SWEEP_ENTRY, data: { decisions: "nope" } }]);
    expect(store.get().size).toBe(0);
  });

  it("removes a decision for /token-saver restore", () => {
    const store = new DecisionStore();
    store.add([decision("a")]);
    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    expect(store.get().size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run packages/pi/test/state.test.ts`
Expected: FAIL, cannot resolve `../src/state.js`.

- [ ] **Step 4: Implement the store and the Jev adapter**

`packages/pi/src/state.ts`:

```ts
import type { Decision, SweepEntryData } from "@token-saver/core";

export const SWEEP_ENTRY = "token-saver/sweep";

export class DecisionStore {
  private decisions = new Map<string, Decision>();

  get(): ReadonlyMap<string, Decision> {
    return this.decisions;
  }

  add(decisions: Decision[]): void {
    for (const decision of decisions) {
      // Decisions are immutable: the first one wins, forever.
      if (!this.decisions.has(decision.id)) this.decisions.set(decision.id, decision);
    }
  }

  rebuildFrom(entries: Array<{ type: string; customType?: string; data?: unknown }>): void {
    this.decisions.clear();
    // Results before a compaction are gone from the context, so their decisions are noise.
    const lastCompaction = entries.map((entry) => entry.type).lastIndexOf("compaction");
    for (const entry of entries.slice(lastCompaction + 1)) {
      if (entry.type !== "custom" || entry.customType !== SWEEP_ENTRY) continue;
      const data = entry.data as Partial<SweepEntryData> | undefined;
      if (!Array.isArray(data?.decisions)) continue;
      this.add(data.decisions);
    }
  }

  remove(id: string): boolean {
    return this.decisions.delete(id);
  }

  stats(): { stubbed: number; partial: number; savedTokens: number } {
    let stubbed = 0;
    let partial = 0;
    let savedTokens = 0;
    for (const decision of this.decisions.values()) {
      if (decision.level === "stub") stubbed++;
      if (decision.level === "partial") partial++;
      savedTokens += decision.savedTokens;
    }
    return { stubbed, partial, savedTokens };
  }
}
```

`packages/pi/src/jev.ts`:

```ts
import type { JevClient, JevRequest } from "@token-saver/core";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Plain fetch rather than the SDK: core builds plain-JSON requests, which the HTTP API takes as-is. */
export function sdkClient(apiKey: string | undefined): JevClient | null {
  if (apiKey === undefined || apiKey.length === 0) return null;
  return {
    async systemOne(request: JevRequest, signal?: AbortSignal) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(`typesafe ${response.status}`);
      return (await response.json()) as { answers: Record<string, { noul: number }> };
    },
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run packages/pi/test/state.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/pi package-lock.json
git commit -m "feat(pi): extension package, decision store, Jev HTTP client"
```

---

### Task 17: The context handler

**Files:**
- Create: `packages/pi/src/context.ts`
- Test: `packages/pi/test/context.test.ts`

**Interfaces:**
- Consumes: `DecisionStore`, `runSweep`, `applyDecisions`, `Config`, `Prices`.
- Produces:
  ```ts
  export interface PiMessage { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; model?: string; usage?: { input: number }; }
  export interface HandleInput {
    messages: PiMessage[];
    store: DecisionStore;
    config: Config;
    client: JevClient | null;
    prices: Prices | null;
    contextFraction: number | null;   // ctx.getContextUsage() as a fraction, null when unknown
    callsSoFar: number;
    lastForcedFraction: number | null;
    lastForcedEligible: number | null;   // eligible-result count at the last forced sweep
    cooldownUntilTurn: number;
    signal?: AbortSignal;
  }
  export interface HandleOutput {
    messages: PiMessage[] | null;     // null = no change to the context
    sweep: SweepOutcome | null;
    trigger: "cost" | "context" | null;
    cooldownUntilTurn: number;
    lastForcedFraction: number | null;
    lastForcedEligible: number | null;
  }
  export function collectResults(messages: PiMessage[]): { results: ResultRef[]; touches: FileTouch[]; task: TaskState; currentTurn: number; };
  export function handleContext(input: HandleInput): Promise<HandleOutput>;
  ```
  Rules: no client or `config.enabled === false` → `{ messages: null }`; decisions always applied before triggers are considered; the context trigger fires when `contextFraction >= config.contextLevel`, something is eligible, and either `lastForcedFraction` is null, the fraction has grown by 0.10, or more results are eligible than at the last forced sweep; the cost trigger is skipped while `currentTurn < cooldownUntilTurn`; after a `post-gate` outcome the cooldown is set to `currentTurn + 3`, while a Jev failure sets no cooldown so the next trigger retries.

- [ ] **Step 1: Write the failing test**

`packages/pi/test/context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import { collectResults, handleContext } from "../src/context.js";
import type { HandleInput, PiMessage } from "../src/context.js";
import { DecisionStore } from "../src/state.js";

const PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
const bigText = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join("\n");

function conversation(): PiMessage[] {
  return [
    { role: "user", content: "fix the login test" },
    { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/app.ts" } }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: bigText }], isError: false },
    { role: "user", content: "now the other file" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "and now this" },
    { role: "assistant", content: [{ type: "text", text: "sure" }] },
    { role: "user", content: "keep going" },
    { role: "assistant", content: [{ type: "text", text: "will do" }] },
  ];
}

const stale: JevClient = {
  systemOne: async (request) => {
    const answers: Record<string, { noul: number }> = {};
    for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.01 };
    return { answers };
  },
};

function input(over: Partial<HandleInput> = {}): HandleInput {
  return {
    messages: conversation(),
    store: new DecisionStore(),
    config: { ...DEFAULT_CONFIG, minResultTokens: 100 },
    client: stale,
    prices: PRICES,
    contextFraction: 0.2,
    callsSoFar: 20,
    lastForcedFraction: null,
    lastForcedEligible: null,
    cooldownUntilTurn: 0,
    ...over,
  };
}

describe("collectResults", () => {
  it("pairs results with their calls and counts turns", () => {
    const collected = collectResults(conversation());
    expect(collected.results).toHaveLength(1);
    expect(collected.results[0]!.toolName).toBe("read");
    expect(collected.results[0]!.input).toEqual({ path: "src/app.ts" });
    expect(collected.currentTurn).toBe(4);
    expect(collected.results[0]!.turnsAgo).toBe(3);
    expect(collected.task.recent_user_messages).toEqual(["and now this", "keep going"]);
  });
});

describe("handleContext", () => {
  it("does nothing without a Jev client", async () => {
    const out = await handleContext(input({ client: null }));
    expect(out.messages).toBeNull();
    expect(out.sweep).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const out = await handleContext(input({ config: { ...DEFAULT_CONFIG, enabled: false } }));
    expect(out.messages).toBeNull();
  });

  it("sweeps and replaces the stale result's text", async () => {
    const out = await handleContext(input());
    expect(out.trigger).toBe("cost");
    expect(out.sweep!.decisions).toHaveLength(1);
    const replaced = out.messages!.find((message) => message.toolCallId === "call_1")!;
    expect(JSON.stringify(replaced.content)).toContain("[token-saver]");
  });

  it("applies stored decisions without sweeping again", async () => {
    const store = new DecisionStore();
    const first = await handleContext(input({ store }));
    store.add(first.sweep!.decisions);
    const second = await handleContext(input({ store, client: { systemOne: async () => { throw new Error("should not be called"); } } }));
    expect(second.sweep!.reason).toBe("no-candidates");
    expect(second.trigger).toBeNull();
    expect(JSON.stringify(second.messages)).toContain("[token-saver]");
  });

  it("forces a sweep when context usage crosses the level", async () => {
    const out = await handleContext(input({
      contextFraction: 0.7,
      // a cost gate this strict would refuse on its own
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBe("context");
    expect(out.lastForcedFraction).toBe(0.7);
    expect(out.lastForcedEligible).toBe(1);
  });

  it("does not force again until usage grows by ten points", async () => {
    const out = await handleContext(input({
      contextFraction: 0.65, lastForcedFraction: 0.6, lastForcedEligible: 1,
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBeNull();
  });

  it("forces again when new results become eligible", async () => {
    const messages = conversation();
    messages.splice(
      3,
      0,
      { role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/b.ts" } }] },
      { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: bigText }], isError: false },
    );
    const out = await handleContext(input({
      messages, contextFraction: 0.65, lastForcedFraction: 0.6, lastForcedEligible: 1,
      config: { ...DEFAULT_CONFIG, minResultTokens: 100, costMargin: 1000 },
    }));
    expect(out.trigger).toBe("context");
    expect(out.lastForcedEligible).toBe(2);
  });

  it("respects the cooldown after a refused post-gate", async () => {
    const keepAll: JevClient = {
      systemOne: async (request) => {
        const answers: Record<string, { noul: number }> = {};
        for (const key of Object.keys(request.questions)) answers[key] = { noul: 0.99 };
        return { answers };
      },
    };
    const first = await handleContext(input({ client: keepAll }));
    expect(first.sweep!.reason).toBe("post-gate");
    expect(first.cooldownUntilTurn).toBe(7);

    const second = await handleContext(input({
      client: { systemOne: async () => { throw new Error("should not be called"); } },
      cooldownUntilTurn: 7,
    }));
    expect(second.sweep).toBeNull();
  });

  it("leaves the context untouched when Jev fails", async () => {
    const out = await handleContext(input({
      client: { systemOne: async () => { throw new Error("boom"); } },
    }));
    expect(out.messages).toBeNull();
    expect(out.sweep!.reason).toBe("judge-failed");
    expect(out.cooldownUntilTurn).toBe(0);   // fail-open: retry at the next trigger
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/pi/test/context.test.ts`
Expected: FAIL, cannot resolve `../src/context.js`.

- [ ] **Step 3: Implement**

`packages/pi/src/context.ts`:

```ts
import { estimateTokens, runSweep, selectEligible } from "@token-saver/core";
import type {
  Config, FileTouch, JevClient, Prices, ResultRef, SweepOutcome, TaskState,
} from "@token-saver/core";
import type { DecisionStore } from "./state.js";

export interface PiMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface HandleInput {
  messages: PiMessage[];
  store: DecisionStore;
  config: Config;
  client: JevClient | null;
  prices: Prices | null;
  contextFraction: number | null;
  callsSoFar: number;
  lastForcedFraction: number | null;
  lastForcedEligible: number | null;
  cooldownUntilTurn: number;
  signal?: AbortSignal;
}

export interface HandleOutput {
  messages: PiMessage[] | null;
  sweep: SweepOutcome | null;
  trigger: "cost" | "context" | null;
  cooldownUntilTurn: number;
  lastForcedFraction: number | null;
  lastForcedEligible: number | null;
}

const TOUCH_KIND: Record<string, FileTouch["kind"]> = { read: "read", edit: "edit", write: "write" };
const FORCE_STEP = 0.1;
const COOLDOWN_TURNS = 3;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function pathArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function collectResults(messages: PiMessage[]): {
  results: ResultRef[];
  touches: FileTouch[];
  task: TaskState;
  currentTurn: number;
} {
  const results: ResultRef[] = [];
  const resultTurns: number[] = [];
  const touches: FileTouch[] = [];
  const userMessages: string[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown>; turn: number }>();
  let currentTurn = 0;
  let latestAssistantText = "";

  messages.forEach((message, messageIndex) => {
    if (message.role === "user") {
      currentTurn++;
      userMessages.push(textOf(message.content));
      return;
    }
    if (message.role === "assistant") {
      latestAssistantText = textOf(message.content) || latestAssistantText;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const call = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
        if (call.type !== "toolCall" || call.id === undefined || call.name === undefined) continue;
        const args = call.arguments ?? {};
        calls.set(call.id, { name: call.name, args, turn: currentTurn });
        const kind = TOUCH_KIND[call.name];
        const path = pathArg(args);
        if (kind !== undefined && path !== null) touches.push({ path, messageIndex, kind });
      }
      return;
    }
    if (message.role !== "toolResult") return;

    const id = message.toolCallId ?? `unknown_${messageIndex}`;
    const call = calls.get(id);
    const text = textOf(message.content);
    results.push({
      id,
      toolName: message.toolName ?? call?.name ?? "unknown",
      input: call?.args ?? {},
      text,
      tokens: estimateTokens(text),
      messageIndex,
      turnsAgo: 0, // filled in below, against the final turn count
      isError: message.isError === true,
    });
    resultTurns.push(call?.turn ?? currentTurn);
  });

  return {
    // turnsAgo is measured from the latest turn, not from the turn the result
    // arrived in — mid-walk it would always be zero.
    results: results.map((result, i) => ({ ...result, turnsAgo: currentTurn - resultTurns[i]! })),
    touches,
    currentTurn,
    task: {
      recent_user_messages: userMessages.slice(-2),
      latest_assistant_text: latestAssistantText,
      working_files: [...new Set(touches.filter((t) => t.kind !== "read").map((t) => t.path))],
    },
  };
}

function withDecisions(messages: PiMessage[], store: DecisionStore): PiMessage[] | null {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "toolResult" || message.toolCallId === undefined) return message;
    const decision = store.get().get(message.toolCallId);
    if (decision === undefined || decision.rendered === null) return message;
    changed = true;
    return { ...message, content: [{ type: "text", text: decision.rendered }] };
  });
  return changed ? out : null;
}

export async function handleContext(input: HandleInput): Promise<HandleOutput> {
  const unchanged: HandleOutput = {
    messages: null, sweep: null, trigger: null,
    cooldownUntilTurn: input.cooldownUntilTurn,
    lastForcedFraction: input.lastForcedFraction,
    lastForcedEligible: input.lastForcedEligible,
  };
  if (!input.config.enabled || input.client === null) return unchanged;

  const { results, touches, task, currentTurn } = collectResults(input.messages);

  // Relaxed eligibility, because that is what a forced sweep would act on.
  const eligibleCount = selectEligible(results, input.store.get(), input.config, { minTurnsAgo: 1 }).length;
  const fraction = input.contextFraction;
  const forced =
    fraction !== null &&
    fraction >= input.config.contextLevel &&
    eligibleCount > 0 &&
    (input.lastForcedFraction === null ||
      fraction >= input.lastForcedFraction + FORCE_STEP ||
      eligibleCount > (input.lastForcedEligible ?? 0));
  const trigger: "cost" | "context" | null = forced
    ? "context"
    : currentTurn >= input.cooldownUntilTurn
      ? "cost"
      : null;

  if (trigger === null) {
    return { ...unchanged, messages: withDecisions(input.messages, input.store) };
  }

  const tokensByIndex = new Map(results.map((result) => [result.messageIndex, result.tokens]));
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
    tokensAfter: (messageIndex) => {
      let sum = 0;
      for (const [index, tokens] of tokensByIndex) if (index >= messageIndex) sum += tokens;
      return sum;
    },
    callsSoFar: input.callsSoFar,
    prices: input.prices,
    config: input.config,
    client: input.client,
    currentTurn,
    trigger,
    signal: input.signal,
  });

  input.store.add(outcome.decisions);

  return {
    messages: withDecisions(input.messages, input.store),
    sweep: outcome,
    trigger: outcome.decisions.length > 0 ? trigger : null,
    // Only a refused post-gate cools down; a Jev failure retries at the next trigger.
    cooldownUntilTurn:
      outcome.reason === "post-gate" ? currentTurn + COOLDOWN_TURNS : input.cooldownUntilTurn,
    lastForcedFraction: forced ? fraction : input.lastForcedFraction,
    lastForcedEligible: forced ? eligibleCount : input.lastForcedEligible,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/pi/test/context.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/pi/src/context.ts packages/pi/test/context.test.ts
git commit -m "feat(pi): context handler with cost and context-limit triggers"
```

---

### Task 18: The recall tool

**Files:**
- Create: `packages/pi/src/recall.ts`
- Test: `packages/pi/test/recall.test.ts`

**Interfaces:**
- Consumes: pi's session entries.
- Produces:
  ```ts
  export interface RecallSource { findResultText(toolCallId: string): string | null; }
  export function sessionSource(entries: Array<{ type: string; message?: { role: string; toolCallId?: string; content?: unknown } }>): RecallSource;
  export function recall(source: RecallSource, params: { id: string; startLine?: number; endLine?: number }): { content: [{ type: "text"; text: string }]; isError: boolean };
  ```
  Line numbers are 1-based and inclusive, clamped to the text's length. An unknown id is an error result naming the id, never a throw.

- [ ] **Step 1: Write the failing test**

`packages/pi/test/recall.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recall, sessionSource } from "../src/recall.js";

const entries = [
  { type: "message", message: { role: "user", content: "hello" } },
  {
    type: "message",
    message: {
      role: "toolResult", toolCallId: "call_83",
      content: [{ type: "text", text: "alpha\nbeta\ngamma\ndelta" }],
    },
  },
];

describe("sessionSource", () => {
  it("finds a result's text by tool call id", () => {
    expect(sessionSource(entries).findResultText("call_83")).toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("returns null for an unknown id", () => {
    expect(sessionSource(entries).findResultText("nope")).toBeNull();
  });
});

describe("recall", () => {
  const source = sessionSource(entries);

  it("returns the whole text by default", () => {
    const result = recall(source, { id: "call_83" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("returns an inclusive line range", () => {
    expect(recall(source, { id: "call_83", startLine: 2, endLine: 3 }).content[0].text).toBe("beta\ngamma");
  });

  it("clamps out-of-range line numbers", () => {
    expect(recall(source, { id: "call_83", startLine: 0, endLine: 99 }).content[0].text)
      .toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("reports an unknown id as an error result, naming the id", () => {
    const result = recall(source, { id: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run packages/pi/test/recall.test.ts`
Expected: FAIL, cannot resolve `../src/recall.js`.

- [ ] **Step 3: Implement**

`packages/pi/src/recall.ts`:

```ts
export interface RecallSource {
  findResultText(toolCallId: string): string | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function sessionSource(
  entries: Array<{ type: string; message?: { role: string; toolCallId?: string; content?: unknown } }>,
): RecallSource {
  return {
    findResultText(toolCallId: string): string | null {
      for (const entry of entries) {
        const message = entry.message;
        if (entry.type !== "message" || message === undefined) continue;
        if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
        return textOf(message.content);
      }
      return null;
    },
  };
}

export function recall(
  source: RecallSource,
  params: { id: string; startLine?: number; endLine?: number },
): { content: [{ type: "text"; text: string }]; isError: boolean } {
  const text = source.findResultText(params.id);
  if (text === null) {
    return {
      content: [{ type: "text", text: `No stored tool result with id "${params.id}".` }],
      isError: true,
    };
  }
  if (params.startLine === undefined && params.endLine === undefined) {
    return { content: [{ type: "text", text }], isError: false };
  }
  const lines = text.split("\n");
  const start = Math.max(1, params.startLine ?? 1);
  const end = Math.min(lines.length, params.endLine ?? lines.length);
  return { content: [{ type: "text", text: lines.slice(start - 1, end).join("\n") }], isError: false };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run packages/pi/test/recall.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/pi/src/recall.ts packages/pi/test/recall.test.ts
git commit -m "feat(pi): recall tool reading originals from the session"
```

---

### Task 19: Wire the extension together

**Files:**
- Create: `packages/pi/src/ui.ts`
- Modify: `packages/pi/src/index.ts`
- Test: manual, in a real pi session (steps below)

**Interfaces:**
- Consumes: everything from Tasks 16–18.
- Produces: the loadable extension. No new exported functions beyond `renderSweepEntry(data: SweepEntryData): string` in `ui.ts`.

**Execution note (controller ruling):** Steps 1 and 6 need an interactive pi
session and a live `TYPESAFE_API_KEY`, neither of which is available here. Do not
block on them. Instead: handle both price shapes in `priceOf` (per-token values
are `< 0.001`, per-Mtok values are `>= 0.001` — divide the latter by 1e6), record
that in a comment where the code reads `ctx.model.cost`, and leave the probe from
Step 1 out of the committed extension. For Step 6, build the extension, confirm
it loads far enough to fail only on the missing key, and write the manual
checklist into the report for the user to run. Also check pi's own extension
docs (`node_modules/@earendil-works/pi-coding-agent`, or the published docs for
0.85.1) for the exact `registerTool` parameter-schema format before writing
Step 5's code — if it wants TypeBox rather than a plain JSON schema, follow the
docs and note the change in your report.

- [ ] **Step 1: Confirm the price units before trusting the cost gate**

Add this temporary logging to `session_start` and run pi once:

```ts
pi.on("session_start", async (_event, ctx) => {
  console.error("[token-saver] model cost:", JSON.stringify(ctx.model?.cost));
});
```

Run: `pi --extension packages/pi/dist/token-saver.js` (after Step 3's build), send one message, then check the printed object.
Expected: a `{ input, output, cacheRead, cacheWrite }` object. **Per-token values look like `0.000003`; per-Mtok values look like `3`.** `priceOf` below divides per-Mtok values by 1e6. Record which one pi uses in a comment, and remove the logging afterwards.

- [ ] **Step 2: Write the UI helper**

`packages/pi/src/ui.ts`:

```ts
import type { SweepEntryData } from "@token-saver/core";

export function renderSweepEntry(data: SweepEntryData): string {
  const saved = data.decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
  const shortened = data.decisions.length;
  const approx = saved >= 1000 ? `~${(saved / 1000).toFixed(1)}k` : `~${saved}`;
  return `token-saver  ${shortened} result${shortened === 1 ? "" : "s"} shortened · ${approx} tokens freed`;
}
```

- [ ] **Step 3: Write the extension entry point**

`packages/pi/src/index.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@token-saver/core";
import type { Config, Prices, SweepEntryData } from "@token-saver/core";
import { handleContext } from "./context.js";
import type { PiMessage } from "./context.js";
import { sdkClient } from "./jev.js";
import { recall, sessionSource } from "./recall.js";
import { DecisionStore, SWEEP_ENTRY } from "./state.js";
import { renderSweepEntry } from "./ui.js";

const GUIDELINE =
  "Older tool results may appear shortened, marked `[token-saver] … elided …`. The full text " +
  "is still available: call recall with the id shown to get it back, with optional " +
  "startLine/endLine. Recall when you need details, and don't guess at elided content.";

export default function extension(pi: any) {
  const store = new DecisionStore();
  let config: Config = loadConfig({
    files: [join(homedir(), ".pi", "token-saver.json"), join(process.cwd(), ".pi", "token-saver.json")],
  });
  const client = sdkClient(process.env.TYPESAFE_API_KEY);
  let callsSoFar = 0;
  let cooldownUntilTurn = 0;
  let lastForcedFraction: number | null = null;
  let lastForcedEligible: number | null = null;
  let jevTokens = 0;
  let recalls = 0;

  const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

  // Units confirmed in Task 19 Step 1; adjust the divisor if pi reports per-Mtok prices.
  const priceOf = (ctx: any): Prices | null => {
    const cost = ctx.model?.cost;
    if (cost === undefined || typeof cost.cacheWrite !== "number" || cost.cacheWrite === 0) return null;
    const scale = cost.input > 0.001 ? 1e6 : 1;
    return { input: cost.input / scale, cacheRead: cost.cacheRead / scale, cacheWrite: cost.cacheWrite / scale };
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    store.rebuildFrom(ctx.sessionManager.getEntries());
    if (client === null) {
      ctx.ui?.notify?.("token-saver: TYPESAFE_API_KEY is not set, staying inert", "warn");
    }
  });

  pi.on("session_tree", async (_event: unknown, ctx: any) => {
    store.rebuildFrom(ctx.sessionManager.buildContextEntries());
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!config.enabled || client === null) return;
    const options = event.systemPromptOptions;
    if (options?.promptGuidelines && !options.promptGuidelines.includes(GUIDELINE)) {
      options.promptGuidelines.push(GUIDELINE); // added once; pi patches only changed sections
    }
  });

  pi.on("context", async (event: any, ctx: any) => {
    callsSoFar++;
    const usage = ctx.getContextUsage?.();
    const fraction =
      usage && typeof usage.tokens === "number" && typeof usage.maxTokens === "number" && usage.maxTokens > 0
        ? usage.tokens / usage.maxTokens
        : null;

    const outcome = await handleContext({
      messages: event.messages as PiMessage[],
      store,
      config,
      client,
      prices: priceOf(ctx),
      contextFraction: fraction,
      callsSoFar,
      lastForcedFraction,
      lastForcedEligible,
      cooldownUntilTurn,
      signal: ctx.signal,
    });

    cooldownUntilTurn = outcome.cooldownUntilTurn;
    lastForcedFraction = outcome.lastForcedFraction;
    lastForcedEligible = outcome.lastForcedEligible;
    if (outcome.sweep !== null) jevTokens += outcome.sweep.jevInputTokens;

    if (outcome.sweep !== null && outcome.sweep.decisions.length > 0) {
      const data: SweepEntryData = {
        decisions: outcome.sweep.decisions,
        trigger: outcome.trigger ?? "cost",
        at: new Date().toISOString(),
      };
      pi.appendEntry(SWEEP_ENTRY, data);
    }
    return outcome.messages === null ? undefined : { messages: outcome.messages };
  });

  pi.registerEntryRenderer(SWEEP_ENTRY, (entry: { data: SweepEntryData }) => renderSweepEntry(entry.data));

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Restore the full text of a tool result that token-saver shortened. Use the id from a " +
      "[token-saver] marker. startLine/endLine fetch part of a file read. Call this instead of " +
      "guessing, or re-running the command, when you need elided detail.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["id"],
    },
    async execute(_toolCallId: string, params: { id: string; startLine?: number; endLine?: number }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      recalls++;
      return recall(sessionSource(ctx.sessionManager.getEntries()), params);
    },
  });

  pi.registerCommand("token-saver", {
    description: "Show or change token-saver status",
    handler: async (args: string, ctx: any) => {
      const argument = args.trim();
      if (argument === "off" || argument === "on") {
        config = { ...config, enabled: argument === "on" };
        ctx.ui.notify(`token-saver ${argument}`, "info");
        return;
      }
      if (argument.startsWith("restore ")) {
        const id = argument.slice("restore ".length).trim();
        ctx.ui.notify(
          store.remove(id)
            ? `token-saver restored ${id} (one cache reset)`
            : `token-saver has no decision for ${id}`,
          "info",
        );
        return;
      }
      const stats = store.stats();
      ctx.ui.notify(
        `token-saver: ${stats.stubbed} stubbed, ${stats.partial} partial, ` +
        `~${(stats.savedTokens / 1000).toFixed(1)}k tokens freed, ${recalls} recalls, ` +
        `jev spend ~$${(jevTokens * JEV_PRICE_PER_TOKEN).toFixed(4)}`,
        "info",
      );
    },
  });
}
```

- [ ] **Step 4: Build and type-check**

Run: `npm run build -w @token-saver/pi && npx tsc -b packages/core packages/replay packages/pi`
Expected: `wrote packages/pi/dist/token-saver.js`, no type errors. The `any` types on pi's objects are deliberate: pi's exported types can be adopted later, but `core` stays typed.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: all tests pass across the three packages.

- [ ] **Step 6: Try it in a real session**

Run:

```bash
export TYPESAFE_API_KEY=...
pi --extension "$(pwd)/packages/pi/dist/token-saver.js"
```

In that session: read a large file, do several unrelated turns, then check `/token-saver`. Expected: a sweep line in the transcript once enough large results have built up, and `/token-saver` reporting the stubbed count. Verify by asking the agent about elided content that it calls `recall` rather than guessing.

- [ ] **Step 7: Commit**

```bash
git add packages/pi/src/index.ts packages/pi/src/ui.ts
git commit -m "feat(pi): wire extension: context sweeps, recall tool, commands, TUI entry"
```

---

### Task 20: Install docs and the README

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-09-17-token-saver-g-design.md` (status line only)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the README**

Cover, in this order: what the extension does in three sentences; installation (`npm install && npm run build -w @token-saver/pi`, then add the built path to pi's `extensions` setting or pass `--extension`); the `TYPESAFE_API_KEY` requirement and that a missing key means the extension does nothing; the settings table copied from the spec; `/token-saver`, `/token-saver off|on`, `/token-saver restore <id>`; how to run the replay harness; and a "how it works" paragraph linking to the spec.

- [ ] **Step 2: Update the spec's status line**

Change `Status: approved design, not yet implemented` to `Status: implemented (G); C deferred`.

- [ ] **Step 3: Verify the README's commands actually work**

Run every command in the README in order, in a clean clone: `npm install`, `npm run build -w @token-saver/pi`, `npx vitest run`, and the replay command against the fixture.
Expected: each succeeds. Fix the README where it doesn't.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-17-token-saver-g-design.md
git commit -m "docs: README with install, settings, commands, and replay usage"
```

---

## Out of scope for this plan

- **The live A/B test (spec section 9.3).** It needs a task set with repos, prompts and verification commands, which is its own piece of work. Write that plan after the replay baseline in Task 15 shows G saves anything.
- **Feature C (spec section 11).** A separate plan, on the same `core`.
