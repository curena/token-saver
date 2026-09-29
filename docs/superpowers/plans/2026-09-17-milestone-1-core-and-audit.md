# token-saver Milestone 1: Core + Setup Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `token-saver audit` command that inventories Claude Code's per-session fixed costs, judges each item's fit to the current project with TypeSafe Jev, and proposes, applies and undoes `skillOverrides` settings.

**Architecture:** A pure `src/core/` library (no fs, no network, no clock) holds redaction, policy and Jev question builders. `src/runtime/` is the only layer that touches disk or network. `src/audit/` composes them into a CLI. Every Jev call is redacted, cached, deadline-bound and fail-open: a failure returns `null` and the caller falls back to a code-only decision.

**Tech Stack:** TypeScript 5.x on Node 20+ (dev machine runs v24), `@typesafe-ai/sdk` ^0.6, vitest for tests, tsx for running the CLI in dev, tsc for builds. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-token-saver-design.md`

## Global Constraints

- Node 20 or newer (`engines.node: ">=20"`); `@typesafe-ai/sdk` ^0.6 is the only runtime dependency.
- `src/core/**` must not import `node:fs`, `node:https`, `Date.now()` or the TypeSafe client. Timestamps and I/O are passed in.
- **Fail open.** Any Jev error, timeout or missing `TYPESAFE_API_KEY` returns `null`; the caller proceeds with the original/unchanged value.
- Jev calls use `maxRetries: 0` and a firm deadline: 300ms for prompt-time calls, 800ms for tool-result calls, 10000ms for the audit (offline, not latency-critical).
- **Redact before every send.** Path denylist: `.env*`, `*.pem`, `id_*`, `secrets/**`.
- The audit **never** proposes state `off` — `off` would also hide the skill from the user's `/` menu.
- Token counts are estimates: `Math.ceil(text.length / 4)`. No tokenizer dependency.
- Every settings write records the previous value so `--undo` can restore it exactly.
- Tests run with `npm test` (vitest). Each task ends with a commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/types.ts` | Shared types: `SkillState`, `InventoryItem`, `ProjectProfile`, `FitLevel`, `Proposal` |
| `src/core/redact.ts` | Mask secrets in text; path denylist |
| `src/core/policy.ts` | Map (fit, usage) to proposed state; estimate tokens |
| `src/core/questions/fit.ts` | Build Jev Score questions for a batch of items; parse answers |
| `src/runtime/jev.ts` | TypeSafe client wrapper: deadline, no retries, redaction, cache, fail-open |
| `src/runtime/store.ts` | `.token-saver/` layout: cache, audit log, fingerprint |
| `src/audit/inventory-claude-code.ts` | Discover Claude Code skills and their current state |
| `src/audit/usage.ts` | Count skill invocations and recent prompts from Claude Code transcripts |
| `src/audit/profile.ts` | Build the project profile from README, manifests, tree, prompts |
| `src/audit/fingerprint.ts` | Hash profile + inventory to detect setup drift |
| `src/audit/run.ts` | Compose: inventory + usage + profile + Jev into proposals; render; apply; undo |
| `src/adapters/claude-code/paths.ts` | Locate Claude Code's skills, settings and transcripts |
| `src/cli.ts` | `token-saver audit [--apply\|--undo]`, `token-saver hook session-start` |
| `tests/**` | One test file per source file above |

---

### Task 1: Project scaffold and redaction

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/types.ts`, `src/core/redact.ts`
- Test: `tests/core/redact.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type SkillState = "on" | "name-only" | "user-invocable-only" | "off"`
  - `type FitLevel = 1 | 2 | 3 | 4`
  - `interface InventoryItem { id: string; name: string; kind: "skill" | "plugin-skill"; harness: "claude-code" | "pi"; source: string; description: string; tokens: number; managed: boolean; currentState: SkillState }`
  - `interface ProjectProfile { root: string; readme: string; manifests: string[]; tree: string[]; prompts: string[] }`
  - `interface Proposal { id: string; name: string; from: SkillState; to: SkillState; fit: FitLevel | null; uses: number; tokens: number; reason: string }`
  - `redact(text: string): string`
  - `isDenylistedPath(path: string): boolean`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "token-saver",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "token-saver": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": { "@typesafe-ai/sdk": "^0.6.0" },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `vitest.config.ts`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

Then run `npm install`.

- [ ] **Step 3: Create `src/core/types.ts`**

```ts
export type SkillState = "on" | "name-only" | "user-invocable-only" | "off";

export type FitLevel = 1 | 2 | 3 | 4;

export interface InventoryItem {
  /** Stable key: the skill name as settings and transcripts refer to it. */
  id: string;
  name: string;
  kind: "skill" | "plugin-skill";
  harness: "claude-code" | "pi";
  /** Absolute path of the SKILL.md this came from. */
  source: string;
  description: string;
  /** Estimated tokens this item costs in every session's prompt. */
  tokens: number;
  /** False when the harness has no per-project switch for it (plugin skills). */
  managed: boolean;
  currentState: SkillState;
}

export interface ProjectProfile {
  root: string;
  readme: string;
  manifests: string[];
  tree: string[];
  prompts: string[];
}

export interface Proposal {
  id: string;
  name: string;
  from: SkillState;
  to: SkillState;
  fit: FitLevel | null;
  uses: number;
  tokens: number;
  reason: string;
}
```

- [ ] **Step 4: Write the failing test**

`tests/core/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isDenylistedPath, redact } from "../../src/core/redact.js";

describe("redact", () => {
  it("masks an sk- style api key", () => {
    const out = redact("export KEY=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789");
    expect(out).not.toContain("AbCdEf0123456789");
    expect(out).toContain("[REDACTED]");
  });

  it("masks values of env-style assignments", () => {
    expect(redact("DB_PASSWORD=hunter2trustno1")).toBe("DB_PASSWORD=[REDACTED]");
  });

  it("keeps ordinary prose and code untouched", () => {
    const text = "function add(a, b) { return a + b; } // adds two numbers";
    expect(redact(text)).toBe(text);
  });

  it("preserves line count so line ranges stay valid", () => {
    const text = "a\nTOKEN=abcdefghijklmnopqrst\nb";
    expect(redact(text).split("\n")).toHaveLength(3);
  });

  it("flags denylisted paths", () => {
    expect(isDenylistedPath("/home/u/p/.env")).toBe(true);
    expect(isDenylistedPath("/home/u/p/.env.local")).toBe(true);
    expect(isDenylistedPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isDenylistedPath("/home/u/p/secrets/keys.json")).toBe(true);
    expect(isDenylistedPath("/home/u/p/src/index.ts")).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/core/redact.test.ts`
Expected: FAIL, cannot resolve `../../src/core/redact.js`.

- [ ] **Step 6: Write `src/core/redact.ts`**

```ts
const PLACEHOLDER = "[REDACTED]";

/** Token-like literals: provider key prefixes, then JWTs. */
const KEY_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp|AKIA|ASIA)[-_][A-Za-z0-9\-_]{8,}/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
];

/** NAME=value or NAME: value where the name looks secret-ish. */
const ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g;

const DENYLIST: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/,
  /(^|\/)id_[A-Za-z0-9_]+$/,
  /(^|\/)secrets\//,
];

/** True when a high-entropy run looks like a credential rather than prose or code. */
function looksRandom(word: string): boolean {
  if (word.length < 24) return false;
  if (!/^[A-Za-z0-9+/=_\-]+$/.test(word)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(word)).length;
  if (classes < 3) return false;
  const unique = new Set(word).size;
  return unique / word.length > 0.5;
}

export function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  out = out.replace(ASSIGNMENT, (_m, name: string) => `${name}=${PLACEHOLDER}`);
  out = out.replace(/[A-Za-z0-9+/=_\-]{24,}/g, (word) =>
    looksRandom(word) ? PLACEHOLDER : word,
  );
  return out;
}

export function isDenylistedPath(path: string): boolean {
  return DENYLIST.some((re) => re.test(path));
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/core/redact.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/core tests/core
git commit -m "feat: scaffold token-saver package with core types and redaction"
```

---

### Task 2: Audit policy

**Files:**
- Create: `src/core/policy.ts`
- Test: `tests/core/policy.test.ts`

**Interfaces:**
- Consumes: `InventoryItem`, `FitLevel`, `Proposal` from `src/core/types.ts`
- Produces:
  - `estimateTokens(text: string): number`
  - `proposeState(item: InventoryItem, fit: FitLevel | null, uses: number): Proposal`
  - `const RECENT_USE_DAYS = 30`

- [ ] **Step 1: Write the failing test**

`tests/core/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateTokens, proposeState } from "../../src/core/policy.js";
import type { InventoryItem } from "../../src/core/types.js";

const item: InventoryItem = {
  id: "pdf",
  name: "pdf",
  kind: "skill",
  harness: "claude-code",
  source: "/home/u/.claude/skills/pdf/SKILL.md",
  description: "Work with PDF files",
  tokens: 120,
  managed: true,
  currentState: "on",
};

describe("proposeState", () => {
  it("keeps a recently used item on, whatever its fit", () => {
    const p = proposeState(item, 4, 3);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/used/);
  });

  it("keeps a core-fit item on", () => {
    expect(proposeState(item, 1, 0).to).toBe("on");
  });

  it("collapses an occasionally useful item to name-only", () => {
    expect(proposeState(item, 2, 0).to).toBe("name-only");
    expect(proposeState(item, 3, 0).to).toBe("name-only");
  });

  it("hides an irrelevant unused item but keeps it user-invocable", () => {
    expect(proposeState(item, 4, 0).to).toBe("user-invocable-only");
  });

  it("never proposes off", () => {
    const states = [1, 2, 3, 4].map((f) => proposeState(item, f as 1, 0).to);
    expect(states).not.toContain("off");
  });

  it("leaves an item alone when fit is unknown", () => {
    const p = proposeState(item, null, 0);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/no judgment/);
  });

  it("does not propose a change for an unmanaged item", () => {
    const p = proposeState({ ...item, managed: false, kind: "plugin-skill" }, 4, 0);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/not settable/);
  });
});

describe("estimateTokens", () => {
  it("estimates four characters per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/policy.test.ts`
Expected: FAIL, cannot resolve `../../src/core/policy.js`.

- [ ] **Step 3: Write `src/core/policy.ts`**

```ts
import type { FitLevel, InventoryItem, Proposal } from "./types.js";

export const RECENT_USE_DAYS = 30;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Decide the state to propose for one item.
 * Never proposes "off": that would hide the skill from the user's own / menu too.
 */
export function proposeState(
  item: InventoryItem,
  fit: FitLevel | null,
  uses: number,
): Proposal {
  const base = {
    id: item.id,
    name: item.name,
    from: item.currentState,
    fit,
    uses,
    tokens: item.tokens,
  };
  if (!item.managed) {
    return { ...base, to: item.currentState, reason: "not settable per project" };
  }
  if (uses > 0) {
    return { ...base, to: "on", reason: `used ${uses}x in the last ${RECENT_USE_DAYS} days` };
  }
  if (fit === null) {
    return { ...base, to: item.currentState, reason: "no judgment available" };
  }
  if (fit === 1) return { ...base, to: "on", reason: "core to this project" };
  if (fit === 2 || fit === 3) {
    return { ...base, to: "name-only", reason: "occasionally useful; name kept in context" };
  }
  return { ...base, to: "user-invocable-only", reason: "irrelevant here and unused" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/policy.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/policy.ts tests/core/policy.test.ts
git commit -m "feat: add audit policy mapping fit and usage to skill states"
```

---

### Task 3: Fit questions

**Files:**
- Create: `src/core/questions/fit.ts`
- Test: `tests/core/questions/fit.test.ts`

**Interfaces:**
- Consumes: `InventoryItem`, `ProjectProfile`, `FitLevel`
- Produces:
  - `const FIT_BATCH_SIZE = 20`
  - `fitState(profile: ProjectProfile): Record<string, unknown>`
  - `fitQuestions(items: InventoryItem[]): Record<string, ReturnType<typeof score>>`
  - `parseFit(answers: Record<string, { score?: string; confidence?: number }>): Map<string, FitLevel>`

- [ ] **Step 1: Write the failing test**

`tests/core/questions/fit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FIT_BATCH_SIZE, fitQuestions, fitState, parseFit } from "../../../src/core/questions/fit.js";
import type { InventoryItem, ProjectProfile } from "../../../src/core/types.js";

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
    const q = fitQuestions(items)["fit::pdf"] as unknown as { criteria: Record<string, string> };
    expect(Object.keys(q.criteria)).toHaveLength(4);
    for (const text of Object.values(q.criteria)) expect(text.length).toBeGreaterThan(30);
  });

  it("names the item inside the instructions, not just the key", () => {
    const q = fitQuestions(items)["fit::pdf"] as unknown as { instructions: string };
    expect(q.instructions).toContain("Read, edit and create PDF files");
  });

  it("parses answers back to levels keyed by item id", () => {
    const levels = parseFit({ "fit::pdf": { score: "irrelevant", confidence: 0.9 } });
    expect(levels.get("pdf")).toBe(4);
  });

  it("ignores answers for unknown keys", () => {
    expect(parseFit({ other: { score: "core" } }).size).toBe(0);
  });

  it("batches at 20 items", () => {
    expect(FIT_BATCH_SIZE).toBe(20);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/questions/fit.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Write `src/core/questions/fit.ts`**

```ts
import { score } from "@typesafe-ai/sdk";
import type { FitLevel, InventoryItem, ProjectProfile } from "../types.js";

export const FIT_BATCH_SIZE = 20;

const LEVELS: Record<string, FitLevel> = {
  core: 1,
  occasional: 2,
  general: 3,
  irrelevant: 4,
};

const CRITERIA: Record<string, string> = {
  core:
    "The work described in this project regularly needs exactly what this item does; a " +
    "developer working here would reach for it in a normal week.",
  occasional:
    "This project's work touches what this item does now and then, for example a related " +
    "file format, service or workflow that appears occasionally rather than routinely.",
  general:
    "The item is a general-purpose capability with no particular connection to this " +
    "project's subject matter, though it could apply to almost any project.",
  irrelevant:
    "Nothing in this project's code, dependencies or recent requests relates to what this " +
    "item does; using it here would be surprising.",
};

export function fitState(profile: ProjectProfile): Record<string, unknown> {
  return {
    project_root: profile.root,
    readme: profile.readme,
    manifests: profile.manifests,
    file_tree: profile.tree,
    recent_requests: profile.prompts,
  };
}

export function fitQuestions(items: InventoryItem[]) {
  const questions: Record<string, ReturnType<typeof score>> = {};
  for (const item of items) {
    questions[`fit::${item.id}`] = score(
      `An agent working in this project can load a capability called '${item.name}', ` +
        `described as: ${item.description}. How well does it fit the work this project ` +
        `involves, judging from \`readme\`, \`manifests\`, \`file_tree\` and ` +
        "`recent_requests`?",
      CRITERIA,
    );
  }
  return questions;
}

export function parseFit(
  answers: Record<string, { score?: string; confidence?: number }>,
): Map<string, FitLevel> {
  const levels = new Map<string, FitLevel>();
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith("fit::")) continue;
    const level = answer.score ? LEVELS[answer.score] : undefined;
    if (level) levels.set(key.slice("fit::".length), level);
  }
  return levels;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core/questions/fit.test.ts`
Expected: PASS (7 tests).

If the SDK does not export `score` under that name, run
`node -e "import('@typesafe-ai/sdk').then(m => console.log(Object.keys(m)))"` and use the
exported builder for Score questions. The test only requires `instructions` and `criteria` on
the returned object.

- [ ] **Step 5: Commit**

```bash
git add src/core/questions tests/core/questions
git commit -m "feat: add Jev fit questions for inventory items"
```

---

### Task 4: Jev wrapper

**Files:**
- Create: `src/runtime/jev.ts`
- Test: `tests/runtime/jev.test.ts`

**Interfaces:**
- Consumes: `redact` from `src/core/redact.ts`
- Produces:
  - `interface JevClient { systemOne(request: { state: unknown; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<{ answers: Record<string, any> }> }`
  - `interface JevOptions { client?: JevClient | null; deadlineMs?: number; cache?: Map<string, Record<string, any>>; onUsage?: (event: { ms: number; cached: boolean; ok: boolean }) => void }`
  - `class Jev { constructor(options?: JevOptions); ask(state: unknown, questions: Record<string, unknown>): Promise<Record<string, any> | null> }`

- [ ] **Step 1: Write the failing test**

`tests/runtime/jev.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Jev } from "../../src/runtime/jev.js";

const questions = { q: { type: "noul", instructions: "is it?" } };

describe("Jev", () => {
  it("returns null when no client is configured", async () => {
    const jev = new Jev({ client: null });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
  });

  it("redacts state before sending", async () => {
    const seen: unknown[] = [];
    const client = {
      systemOne: async (req: any) => {
        seen.push(req.state);
        return { answers: { q: { noul: 0.9 } } };
      },
    };
    await new Jev({ client }).ask({ log: "API_KEY=abcdefghijklmnopqrstuvwx" }, questions);
    expect(JSON.stringify(seen[0])).toContain("[REDACTED]");
    expect(JSON.stringify(seen[0])).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("returns null when the call exceeds the deadline", async () => {
    const client = {
      systemOne: () => new Promise<any>((resolve) => setTimeout(resolve, 200)),
    };
    const jev = new Jev({ client, deadlineMs: 20 });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
  });

  it("returns null when the client throws", async () => {
    const client = { systemOne: async () => { throw new Error("boom"); } };
    expect(await new Jev({ client }).ask({ a: 1 }, questions)).toBeNull();
  });

  it("serves a repeated request from cache without calling again", async () => {
    const systemOne = vi.fn(async () => ({ answers: { q: { noul: 0.5 } } }));
    const jev = new Jev({ client: { systemOne } });
    await jev.ask({ a: 1 }, questions);
    await jev.ask({ a: 1 }, questions);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("reports usage for both live and cached calls", async () => {
    const events: { cached: boolean; ok: boolean }[] = [];
    const jev = new Jev({
      client: { systemOne: async () => ({ answers: { q: { noul: 0.5 } } }) },
      onUsage: (e) => events.push(e),
    });
    await jev.ask({ a: 1 }, questions);
    await jev.ask({ a: 1 }, questions);
    expect(events.map((e) => e.cached)).toEqual([false, true]);
    expect(events.every((e) => e.ok)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runtime/jev.test.ts`
Expected: FAIL, cannot resolve `../../src/runtime/jev.js`.

- [ ] **Step 3: Write `src/runtime/jev.ts`**

```ts
import { createHash } from "node:crypto";
import { redact } from "../core/redact.js";

export interface JevClient {
  systemOne(
    request: { state: unknown; questions: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers: Record<string, any> }>;
}

export interface JevOptions {
  client?: JevClient | null;
  deadlineMs?: number;
  cache?: Map<string, Record<string, any>>;
  onUsage?: (event: { ms: number; cached: boolean; ok: boolean }) => void;
}

/** Recursively redact every string in a JSON-serialisable value. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

/**
 * Deadline-bound, redacting, caching wrapper. Every failure path returns null so
 * callers fall back to a code-only decision.
 */
export class Jev {
  private readonly client: JevClient | null;
  private readonly deadlineMs: number;
  private readonly cache: Map<string, Record<string, any>>;
  private readonly onUsage?: JevOptions["onUsage"];

  constructor(options: JevOptions = {}) {
    this.client = options.client ?? null;
    this.deadlineMs = options.deadlineMs ?? 10_000;
    this.cache = options.cache ?? new Map();
    this.onUsage = options.onUsage;
  }

  async ask(
    state: unknown,
    questions: Record<string, unknown>,
  ): Promise<Record<string, any> | null> {
    if (!this.client) return null;
    const safeState = redactDeep(state);
    const key = createHash("sha256")
      .update(JSON.stringify({ state: safeState, questions }))
      .digest("hex");

    const hit = this.cache.get(key);
    if (hit) {
      this.onUsage?.({ ms: 0, cached: true, ok: true });
      return hit;
    }

    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.client.systemOne({ state: safeState, questions }, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("token-saver: deadline"));
          }, this.deadlineMs);
        }),
      ]);
      this.cache.set(key, response.answers);
      this.onUsage?.({ ms: Date.now() - started, cached: false, ok: true });
      return response.answers;
    } catch {
      this.onUsage?.({ ms: Date.now() - started, cached: false, ok: false });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/runtime/jev.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/jev.ts tests/runtime/jev.test.ts
git commit -m "feat: add fail-open Jev wrapper with redaction, deadline and cache"
```

---

### Task 5: Store

**Files:**
- Create: `src/runtime/store.ts`
- Test: `tests/runtime/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface AuditEntry { at: string; file: string; previous: Record<string, string>; applied: Record<string, string> }`
  - `class Store { constructor(root: string); readonly base: string; dir(kind: "cache" | "audit" | "recall" | "log"): string; loadCache(name: string): Map<string, any>; saveCache(name: string, cache: Map<string, any>): void; appendAudit(entry: AuditEntry): void; lastAudit(): AuditEntry | null; readFingerprint(): string | null; writeFingerprint(value: string): void }`

- [ ] **Step 1: Write the failing test**

`tests/runtime/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../src/runtime/store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("Store", () => {
  it("round-trips a cache", () => {
    const store = new Store(root);
    store.saveCache("fit", new Map<string, any>([["k", { a: 1 }]]));
    expect(new Store(root).loadCache("fit").get("k")).toEqual({ a: 1 });
  });

  it("returns an empty cache when none exists", () => {
    expect(new Store(root).loadCache("missing").size).toBe(0);
  });

  it("returns the most recent audit entry", () => {
    const store = new Store(root);
    store.appendAudit({ at: "2026-01-01T00:00:00Z", file: "a.json", previous: {}, applied: { x: "on" } });
    store.appendAudit({ at: "2026-01-02T00:00:00Z", file: "b.json", previous: { y: "on" }, applied: { y: "name-only" } });
    expect(store.lastAudit()?.file).toBe("b.json");
  });

  it("returns null when there is no audit history", () => {
    expect(new Store(root).lastAudit()).toBeNull();
  });

  it("round-trips a fingerprint", () => {
    const store = new Store(root);
    expect(store.readFingerprint()).toBeNull();
    store.writeFingerprint("abc123");
    expect(new Store(root).readFingerprint()).toBe("abc123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runtime/store.test.ts`
Expected: FAIL, cannot resolve `../../src/runtime/store.js`.

- [ ] **Step 3: Write `src/runtime/store.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  at: string;
  /** Settings file the change was written to. */
  file: string;
  /** Previous value of each key; a key absent here did not exist before. */
  previous: Record<string, string>;
  applied: Record<string, string>;
}

type Kind = "cache" | "audit" | "recall" | "log";

/** Everything token-saver persists lives under <project>/.token-saver/. */
export class Store {
  readonly base: string;

  constructor(root: string) {
    this.base = join(root, ".token-saver");
  }

  dir(kind: Kind): string {
    const path = join(this.base, kind);
    mkdirSync(path, { recursive: true });
    return path;
  }

  loadCache(name: string): Map<string, any> {
    const file = join(this.dir("cache"), `${name}.json`);
    if (!existsSync(file)) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8"))));
    } catch {
      return new Map();
    }
  }

  saveCache(name: string, cache: Map<string, any>): void {
    const file = join(this.dir("cache"), `${name}.json`);
    writeFileSync(file, JSON.stringify(Object.fromEntries(cache)), "utf8");
  }

  appendAudit(entry: AuditEntry): void {
    appendFileSync(join(this.dir("audit"), "log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  lastAudit(): AuditEntry | null {
    const file = join(this.dir("audit"), "log.jsonl");
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as AuditEntry;
  }

  readFingerprint(): string | null {
    const file = join(this.dir("audit"), "fingerprint");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  }

  writeFingerprint(value: string): void {
    writeFileSync(join(this.dir("audit"), "fingerprint"), value, "utf8");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/runtime/store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/store.ts tests/runtime/store.test.ts
git commit -m "feat: add .token-saver store for cache, audit log and fingerprint"
```

---

### Task 6: Claude Code inventory

**Files:**
- Create: `src/audit/inventory-claude-code.ts`
- Test: `tests/audit/inventory-claude-code.test.ts`

**Interfaces:**
- Consumes: `InventoryItem`, `SkillState`, `estimateTokens`
- Produces:
  - `interface ScanOptions { userSkillsDir: string; projectSkillsDir: string; pluginSkillDirs?: string[]; settingsPath: string }`
  - `scanClaudeCode(options: ScanOptions): InventoryItem[]`
  - `readSkillOverrides(settingsPath: string): Record<string, SkillState>`

- [ ] **Step 1: Write the failing test**

`tests/audit/inventory-claude-code.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanClaudeCode } from "../../src/audit/inventory-claude-code.js";

let root: string;

function writeSkill(dir: string, name: string, frontmatter: string, body = "Body text.") {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-inv-"));
  for (const d of ["user", "project", "plugin"]) mkdirSync(join(root, d), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function scan() {
  return scanClaudeCode({
    userSkillsDir: join(root, "user"),
    projectSkillsDir: join(root, "project"),
    pluginSkillDirs: [join(root, "plugin")],
    settingsPath: join(root, "settings.local.json"),
  });
}

describe("scanClaudeCode", () => {
  it("finds skills in the user and project directories", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: Work with PDFs");
    writeSkill(join(root, "project"), "deploy", "name: deploy\ndescription: Ship the app");
    expect(scan().map((i) => i.id).sort()).toEqual(["deploy", "pdf"]);
  });

  it("reads the description from frontmatter and estimates tokens", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: Work with PDF files");
    const item = scan()[0];
    expect(item.description).toBe("Work with PDF files");
    expect(item.tokens).toBeGreaterThan(0);
  });

  it("appends when_to_use to the description", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs\nwhen_to_use: When a .pdf is mentioned");
    expect(scan()[0].description).toBe("PDFs When a .pdf is mentioned");
  });

  it("marks plugin skills unmanaged", () => {
    writeSkill(join(root, "plugin"), "chart", "name: chart\ndescription: Make charts");
    const item = scan()[0];
    expect(item.kind).toBe("plugin-skill");
    expect(item.managed).toBe(false);
  });

  it("reads the current state from skillOverrides", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(
      join(root, "settings.local.json"),
      JSON.stringify({ skillOverrides: { pdf: "name-only" } }),
      "utf8",
    );
    expect(scan()[0].currentState).toBe("name-only");
  });

  it("defaults the state to on when settings do not mention the skill", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    expect(scan()[0].currentState).toBe("on");
  });

  it("skips a directory without SKILL.md", () => {
    mkdirSync(join(root, "user", "not-a-skill"), { recursive: true });
    expect(scan()).toHaveLength(0);
  });

  it("skips a skill whose frontmatter has no description", () => {
    writeSkill(join(root, "user"), "bare", "name: bare");
    expect(scan()).toHaveLength(0);
  });

  it("survives a missing skills directory", () => {
    rmSync(join(root, "project"), { recursive: true, force: true });
    expect(() => scan()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/audit/inventory-claude-code.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Write `src/audit/inventory-claude-code.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../core/policy.js";
import type { InventoryItem, SkillState } from "../core/types.js";

export interface ScanOptions {
  userSkillsDir: string;
  projectSkillsDir: string;
  pluginSkillDirs?: string[];
  settingsPath: string;
}

const STATES: string[] = ["on", "name-only", "user-invocable-only", "off"];

export function readSkillOverrides(settingsPath: string): Record<string, SkillState> {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      skillOverrides?: Record<string, string>;
    };
    const out: Record<string, SkillState> = {};
    for (const [name, state] of Object.entries(parsed.skillOverrides ?? {})) {
      if (STATES.includes(state)) out[name] = state as SkillState;
    }
    return out;
  } catch {
    return {};
  }
}

/** Minimal frontmatter reader: `key: value` lines between the leading --- fences. */
function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

function scanDir(
  dir: string,
  kind: InventoryItem["kind"],
  overrides: Record<string, SkillState>,
): InventoryItem[] {
  if (!existsSync(dir)) return [];
  const items: InventoryItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(dir, entry.name, "SKILL.md");
    if (!existsSync(source)) continue;
    const fields = parseFrontmatter(readFileSync(source, "utf8"));
    if (!fields.description) continue;
    const name = fields.name || entry.name;
    const description = fields.when_to_use
      ? `${fields.description} ${fields.when_to_use}`
      : fields.description;
    items.push({
      id: name,
      name,
      kind,
      harness: "claude-code",
      source,
      description,
      tokens: estimateTokens(`${name}: ${description}`),
      managed: kind === "skill",
      currentState: overrides[name] ?? "on",
    });
  }
  return items;
}

export function scanClaudeCode(options: ScanOptions): InventoryItem[] {
  const overrides = readSkillOverrides(options.settingsPath);
  return [
    ...scanDir(options.userSkillsDir, "skill", overrides),
    ...scanDir(options.projectSkillsDir, "skill", overrides),
    ...(options.pluginSkillDirs ?? []).flatMap((dir) => scanDir(dir, "plugin-skill", overrides)),
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/audit/inventory-claude-code.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/audit/inventory-claude-code.ts tests/audit/inventory-claude-code.test.ts
git commit -m "feat: inventory Claude Code skills with current override state"
```

---

### Task 7: Usage counts and project profile

**Files:**
- Create: `src/audit/usage.ts`, `src/audit/profile.ts`
- Test: `tests/audit/usage.test.ts`, `tests/audit/profile.test.ts`

**Interfaces:**
- Consumes: `redact`, `ProjectProfile`
- Produces:
  - `countSkillUses(transcriptDir: string, since: Date): Map<string, number>`
  - `recentPrompts(transcriptDir: string, limit: number): string[]`
  - `buildProfile(root: string, prompts: string[]): ProjectProfile`

Claude Code transcripts are JSONL under `~/.claude/projects/<slug>/*.jsonl`. Each line is a
record; assistant tool-use records carry `message.content[]` blocks with `type: "tool_use"`,
and a Skill invocation has `name: "Skill"` with `input.skill`. User prompt records have
`type: "user"` with `message.content` as a string or an array of `{type: "text", text}` blocks.
Unknown or malformed lines are skipped.

- [ ] **Step 1: Write the failing usage test**

`tests/audit/usage.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/audit/usage.test.ts`
Expected: FAIL, cannot resolve `../../src/audit/usage.js`.

- [ ] **Step 3: Write `src/audit/usage.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../core/redact.js";

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

function* records(dir: string): Generator<TranscriptRecord> {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as TranscriptRecord;
      } catch {
        continue;
      }
    }
  }
}

/** "superpowers:brainstorming" and "brainstorming" both count as "brainstorming". */
function bareName(skill: string): string {
  const at = skill.lastIndexOf(":");
  return at === -1 ? skill : skill.slice(at + 1);
}

export function countSkillUses(transcriptDir: string, since: Date): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records(transcriptDir)) {
    if (record.type !== "assistant") continue;
    const at = record.timestamp ? new Date(record.timestamp) : null;
    if (!at || Number.isNaN(at.getTime()) || at < since) continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as any[]) {
      if (block?.type !== "tool_use" || block?.name !== "Skill") continue;
      const skill = block?.input?.skill;
      if (typeof skill !== "string") continue;
      const id = bareName(skill);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function recentPrompts(transcriptDir: string, limit: number): string[] {
  const prompts: { at: number; text: string }[] = [];
  for (const record of records(transcriptDir)) {
    if (record.type !== "user") continue;
    const content = record.message?.content;
    let text: string | null = null;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = (content as any[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    if (!text || !text.trim()) continue;
    prompts.push({
      at: record.timestamp ? Date.parse(record.timestamp) : 0,
      text: redact(text.trim()),
    });
  }
  return prompts.sort((a, b) => b.at - a.at).slice(0, limit).map((p) => p.text);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/audit/usage.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing profile test**

`tests/audit/profile.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfile } from "../../src/audit/profile.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-profile-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("buildProfile", () => {
  it("reads the start of the README", () => {
    writeFileSync(join(root, "README.md"), "# proj\nA CLI tool.", "utf8");
    expect(buildProfile(root, []).readme).toContain("A CLI tool.");
  });

  it("caps the README at 2000 characters", () => {
    writeFileSync(join(root, "README.md"), "x".repeat(5000), "utf8");
    expect(buildProfile(root, []).readme).toHaveLength(2000);
  });

  it("includes manifests it recognises", () => {
    writeFileSync(join(root, "package.json"), '{"name":"proj"}', "utf8");
    expect(buildProfile(root, []).manifests.join()).toContain("package.json");
  });

  it("lists the top-level tree without dot directories", () => {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    const tree = buildProfile(root, []).tree;
    expect(tree).toContain("src/");
    expect(tree.join()).not.toContain(".git");
  });

  it("carries the prompts it is given", () => {
    expect(buildProfile(root, ["do a thing"]).prompts).toEqual(["do a thing"]);
  });

  it("works in an empty directory", () => {
    const profile = buildProfile(root, []);
    expect(profile.readme).toBe("");
    expect(profile.manifests).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/audit/profile.test.ts`
Expected: FAIL, cannot resolve `../../src/audit/profile.js`.

- [ ] **Step 7: Write `src/audit/profile.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectProfile } from "../core/types.js";

const README_LIMIT = 2000;
const MANIFEST_LIMIT = 1500;
const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
];

export function buildProfile(root: string, prompts: string[]): ProjectProfile {
  const readmePath = ["README.md", "readme.md", "README"]
    .map((name) => join(root, name))
    .find((path) => existsSync(path));
  const readme = readmePath ? readFileSync(readmePath, "utf8").slice(0, README_LIMIT) : "";

  const manifests = MANIFESTS.filter((name) => existsSync(join(root, name))).map(
    (name) => `${name}: ${readFileSync(join(root, name), "utf8").slice(0, MANIFEST_LIMIT)}`,
  );

  const tree = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
    : [];

  return { root, readme, manifests, tree, prompts };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/audit/profile.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add src/audit/usage.ts src/audit/profile.ts tests/audit/usage.test.ts tests/audit/profile.test.ts
git commit -m "feat: derive skill usage counts and project profile from local state"
```

---

### Task 8: Audit run, render, apply and undo

**Files:**
- Create: `src/audit/run.ts`, `src/audit/fingerprint.ts`
- Test: `tests/audit/run.test.ts`, `tests/audit/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Jev`, `Store`, `AuditEntry`, `InventoryItem`, `ProjectProfile`, `Proposal`, `proposeState`, `fitQuestions`, `fitState`, `parseFit`, `FIT_BATCH_SIZE`
- Produces:
  - `judgeFit(jev: Jev, profile: ProjectProfile, items: InventoryItem[]): Promise<Map<string, FitLevel>>`
  - `buildProposals(items: InventoryItem[], fits: Map<string, FitLevel>, uses: Map<string, number>): Proposal[]`
  - `renderProposals(proposals: Proposal[]): string`
  - `applyProposals(proposals: Proposal[], settingsPath: string, store: Store, now: Date): number`
  - `undoLast(store: Store): string`
  - `fingerprint(profile: ProjectProfile, items: InventoryItem[]): string`

- [ ] **Step 1: Write the failing fingerprint test**

`tests/audit/fingerprint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/audit/fingerprint.js";
import type { InventoryItem, ProjectProfile } from "../../src/core/types.js";

const profile: ProjectProfile = { root: "/p", readme: "r", manifests: [], tree: ["src/"], prompts: ["x"] };
const item: InventoryItem = {
  id: "pdf", name: "pdf", kind: "skill", harness: "claude-code", source: "/s",
  description: "PDFs", tokens: 10, managed: true, currentState: "on",
};

describe("fingerprint", () => {
  it("is stable for the same inputs", () => {
    expect(fingerprint(profile, [item])).toBe(fingerprint(profile, [item]));
  });

  it("changes when a skill is added", () => {
    const other = { ...item, id: "docx", name: "docx" };
    expect(fingerprint(profile, [item, other])).not.toBe(fingerprint(profile, [item]));
  });

  it("ignores prompt churn, which changes every session", () => {
    const busier = { ...profile, prompts: ["totally different"] };
    expect(fingerprint(busier, [item])).toBe(fingerprint(profile, [item]));
  });

  it("changes when the README changes", () => {
    expect(fingerprint({ ...profile, readme: "new" }, [item])).not.toBe(fingerprint(profile, [item]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/audit/fingerprint.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Write `src/audit/fingerprint.ts`**

```ts
import { createHash } from "node:crypto";
import type { InventoryItem, ProjectProfile } from "../core/types.js";

/**
 * Detects setup drift: the installed items plus the project's stable description.
 * Prompts are excluded on purpose, since they change every session.
 */
export function fingerprint(profile: ProjectProfile, items: InventoryItem[]): string {
  const payload = JSON.stringify({
    readme: profile.readme,
    manifests: profile.manifests,
    tree: profile.tree,
    items: items.map((i) => [i.id, i.kind, i.description]).sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/audit/fingerprint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing run test**

`tests/audit/run.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProposals, buildProposals, judgeFit, renderProposals, undoLast } from "../../src/audit/run.js";
import { Jev } from "../../src/runtime/jev.js";
import { Store } from "../../src/runtime/store.js";
import type { FitLevel, InventoryItem, ProjectProfile } from "../../src/core/types.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-run-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const profile: ProjectProfile = { root: "/p", readme: "A TypeScript CLI", manifests: [], tree: [], prompts: [] };

function item(id: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id, name: id, kind: "skill", harness: "claude-code", source: `/s/${id}`,
    description: `${id} things`, tokens: 30, managed: true, currentState: "on", ...over,
  };
}

describe("judgeFit", () => {
  it("asks in batches of 20 and merges the answers", async () => {
    const batches: number[] = [];
    const client = {
      systemOne: async (req: any) => {
        const keys = Object.keys(req.questions);
        batches.push(keys.length);
        return { answers: Object.fromEntries(keys.map((k) => [k, { score: "irrelevant", confidence: 0.8 }])) };
      },
    };
    const items = Array.from({ length: 25 }, (_, i) => item(`s${i}`));
    const fits = await judgeFit(new Jev({ client }), profile, items);
    expect(batches).toEqual([20, 5]);
    expect(fits.size).toBe(25);
    expect(fits.get("s0")).toBe(4);
  });

  it("returns an empty map when Jev fails, so nothing is proposed", async () => {
    const jev = new Jev({ client: { systemOne: async () => { throw new Error("down"); } } });
    expect((await judgeFit(jev, profile, [item("pdf")])).size).toBe(0);
  });
});

describe("buildProposals", () => {
  it("returns only items whose state would change", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4], ["cli", 1]]);
    const proposals = buildProposals([item("pdf"), item("cli")], fits, new Map());
    expect(proposals.map((p) => p.id)).toEqual(["pdf"]);
    expect(proposals[0].to).toBe("user-invocable-only");
  });

  it("keeps a used skill on even when its fit is low", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    expect(buildProposals([item("pdf")], fits, new Map([["pdf", 2]]))).toHaveLength(0);
  });
});

describe("renderProposals", () => {
  it("shows each change and the total token saving", () => {
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const text = renderProposals(buildProposals([item("pdf")], fits, new Map()));
    expect(text).toContain("pdf");
    expect(text).toContain("user-invocable-only");
    expect(text).toMatch(/30 tokens/);
  });

  it("says so when there is nothing to change", () => {
    expect(renderProposals([])).toMatch(/no changes/i);
  });
});

describe("applyProposals and undoLast", () => {
  it("writes skillOverrides and records the previous values", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, JSON.stringify({ skillOverrides: { cli: "on" }, other: 1 }), "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    const count = applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    expect(count).toBe(1);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written.skillOverrides).toEqual({ cli: "on", pdf: "user-invocable-only" });
    expect(written.other).toBe(1);
    expect(store.lastAudit()?.previous).toEqual({});
  });

  it("creates the settings file when it does not exist", () => {
    const settings = join(root, "settings.local.json");
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, new Store(root), new Date());
    expect(existsSync(settings)).toBe(true);
  });

  it("restores the previous state on undo", () => {
    const settings = join(root, "settings.local.json");
    writeFileSync(settings, JSON.stringify({ skillOverrides: { pdf: "name-only" } }), "utf8");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(
      buildProposals([item("pdf", { currentState: "name-only" })], fits, new Map()),
      settings, store, new Date(),
    );
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("user-invocable-only");
    undoLast(store);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides.pdf).toBe("name-only");
  });

  it("removes a key that did not exist before the apply", () => {
    const settings = join(root, "settings.local.json");
    const store = new Store(root);
    const fits = new Map<string, FitLevel>([["pdf", 4]]);
    applyProposals(buildProposals([item("pdf")], fits, new Map()), settings, store, new Date());
    undoLast(store);
    expect(JSON.parse(readFileSync(settings, "utf8")).skillOverrides).toEqual({});
  });

  it("reports when there is nothing to undo", () => {
    expect(undoLast(new Store(root))).toMatch(/nothing/i);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/audit/run.test.ts`
Expected: FAIL, cannot resolve `../../src/audit/run.js`.

- [ ] **Step 7: Write `src/audit/run.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { proposeState } from "../core/policy.js";
import { FIT_BATCH_SIZE, fitQuestions, fitState, parseFit } from "../core/questions/fit.js";
import type { FitLevel, InventoryItem, ProjectProfile, Proposal } from "../core/types.js";
import type { Jev } from "../runtime/jev.js";
import type { Store } from "../runtime/store.js";

export async function judgeFit(
  jev: Jev,
  profile: ProjectProfile,
  items: InventoryItem[],
): Promise<Map<string, FitLevel>> {
  const state = fitState(profile);
  const fits = new Map<string, FitLevel>();
  for (let i = 0; i < items.length; i += FIT_BATCH_SIZE) {
    const batch = items.slice(i, i + FIT_BATCH_SIZE);
    const answers = await jev.ask(state, fitQuestions(batch));
    if (!answers) continue; // fail open: no judgment, no proposal
    for (const [id, level] of parseFit(answers)) fits.set(id, level);
  }
  return fits;
}

export function buildProposals(
  items: InventoryItem[],
  fits: Map<string, FitLevel>,
  uses: Map<string, number>,
): Proposal[] {
  return items
    .map((item) => proposeState(item, fits.get(item.id) ?? null, uses.get(item.id) ?? 0))
    .filter((proposal) => proposal.to !== proposal.from);
}

const FIT_LABEL: Record<FitLevel, string> = {
  1: "core",
  2: "occasional",
  3: "general",
  4: "irrelevant",
};

export function renderProposals(proposals: Proposal[]): string {
  if (proposals.length === 0) return "No changes proposed.";
  const header = ["skill", "fit", "uses", "change", "cost", "why"];
  const rows = proposals.map((p) => [
    p.name,
    p.fit ? FIT_LABEL[p.fit] : "-",
    String(p.uses),
    `${p.from} -> ${p.to}`,
    `${p.tokens} tokens`,
    p.reason,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  const saved = proposals.filter((p) => p.to !== "on").reduce((sum, p) => sum + p.tokens, 0);
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `Estimated saving: ${saved} tokens per session.`,
  ].join("\n");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function applyProposals(
  proposals: Proposal[],
  settingsPath: string,
  store: Store,
  now: Date,
): number {
  if (proposals.length === 0) return 0;
  const settings = readSettings(settingsPath);
  const overrides = { ...((settings.skillOverrides as Record<string, string>) ?? {}) };

  const previous: Record<string, string> = {};
  const applied: Record<string, string> = {};
  for (const proposal of proposals) {
    if (proposal.id in overrides) previous[proposal.id] = overrides[proposal.id];
    overrides[proposal.id] = proposal.to;
    applied[proposal.id] = proposal.to;
  }

  settings.skillOverrides = overrides;
  writeSettings(settingsPath, settings);
  store.appendAudit({ at: now.toISOString(), file: settingsPath, previous, applied });
  return proposals.length;
}

export function undoLast(store: Store): string {
  const entry = store.lastAudit();
  if (!entry) return "Nothing to undo.";
  const settings = readSettings(entry.file);
  const overrides = { ...((settings.skillOverrides as Record<string, string>) ?? {}) };
  for (const id of Object.keys(entry.applied)) {
    const before = entry.previous[id];
    if (before === undefined) delete overrides[id];
    else overrides[id] = before;
  }
  settings.skillOverrides = overrides;
  writeSettings(entry.file, settings);
  // Record the revert too, so a second undo is a no-op rather than a replay.
  store.appendAudit({ at: entry.at, file: entry.file, previous: entry.applied, applied: {} });
  return `Reverted ${Object.keys(entry.applied).length} change(s) in ${entry.file}.`;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/audit/run.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 9: Commit**

```bash
git add src/audit/run.ts src/audit/fingerprint.ts tests/audit/run.test.ts tests/audit/fingerprint.test.ts
git commit -m "feat: judge fit in batches, propose, render, apply and undo audit changes"
```

---

### Task 9: CLI and SessionStart hook

**Files:**
- Create: `src/cli.ts`, `src/adapters/claude-code/paths.ts`, `src/adapters/claude-code/hooks.json`, `README.md`
- Test: `tests/adapters/claude-code/paths.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-8
- Produces:
  - `projectSlug(root: string): string`
  - `claudePaths(home: string, root: string): { userSkillsDir: string; projectSkillsDir: string; settingsPath: string; transcriptDir: string }`
  - `main(argv: string[]): Promise<number>`

Claude Code stores transcripts under `~/.claude/projects/<slug>/`, where the slug is the
project's absolute path with separators replaced by `-` (`/home/u/proj` becomes `-home-u-proj`).

- [ ] **Step 1: Write the failing paths test**

`tests/adapters/claude-code/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { claudePaths, projectSlug } from "../../../src/adapters/claude-code/paths.js";

describe("projectSlug", () => {
  it("replaces separators with dashes", () => {
    expect(projectSlug("/home/u/proj")).toBe("-home-u-proj");
  });

  it("handles a nested path", () => {
    expect(projectSlug("/home/u/work/proj")).toBe("-home-u-work-proj");
  });
});

describe("claudePaths", () => {
  it("points at the standard locations", () => {
    const p = claudePaths("/home/u", "/home/u/proj");
    expect(p.userSkillsDir).toBe("/home/u/.claude/skills");
    expect(p.projectSkillsDir).toBe("/home/u/proj/.claude/skills");
    expect(p.settingsPath).toBe("/home/u/proj/.claude/settings.local.json");
    expect(p.transcriptDir).toBe("/home/u/.claude/projects/-home-u-proj");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/adapters/claude-code/paths.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 3: Write `src/adapters/claude-code/paths.ts`**

```ts
import { join } from "node:path";

export function projectSlug(root: string): string {
  return root.replace(/[/\\:]/g, "-");
}

export function claudePaths(home: string, root: string) {
  return {
    userSkillsDir: join(home, ".claude", "skills"),
    projectSkillsDir: join(root, ".claude", "skills"),
    settingsPath: join(root, ".claude", "settings.local.json"),
    transcriptDir: join(home, ".claude", "projects", projectSlug(root)),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/adapters/claude-code/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing CLI test**

`tests/cli.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

let home: string;
let project: string;
let out: string[];

function addSkill(name: string, description: string) {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ts-home-"));
  project = mkdtempSync(join(tmpdir(), "ts-proj-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  process.env.TOKEN_SAVER_HOME = home;
  process.env.TOKEN_SAVER_ROOT = project;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.TOKEN_SAVER_HOME;
  delete process.env.TOKEN_SAVER_ROOT;
});

describe("cli", () => {
  it("prints usage and exits non-zero for an unknown command", async () => {
    expect(await main(["wat"])).toBe(1);
    expect(out.join("\n")).toMatch(/usage/i);
  });

  it("audits with no API key and proposes nothing, without failing", async () => {
    addSkill("pdf", "PDFs");
    expect(await main(["audit"])).toBe(0);
    expect(out.join("\n")).toMatch(/no changes/i);
  });

  it("session-start prints nothing when the fingerprint is unchanged", async () => {
    addSkill("pdf", "PDFs");
    await main(["audit"]); // writes the first fingerprint
    out.length = 0;
    expect(await main(["hook", "session-start"])).toBe(0);
    expect(out.join("")).toBe("");
  });

  it("session-start emits a systemMessage after the setup changes", async () => {
    addSkill("pdf", "PDFs");
    await main(["audit"]);
    addSkill("new-skill", "Fresh");
    out.length = 0;
    expect(await main(["hook", "session-start"])).toBe(0);
    expect(JSON.parse(out.join("")).systemMessage).toMatch(/token-saver audit/);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 7: Write `src/cli.ts`**

```ts
import { homedir } from "node:os";
import { claudePaths } from "./adapters/claude-code/paths.js";
import { fingerprint } from "./audit/fingerprint.js";
import { scanClaudeCode } from "./audit/inventory-claude-code.js";
import { buildProfile } from "./audit/profile.js";
import { applyProposals, buildProposals, judgeFit, renderProposals, undoLast } from "./audit/run.js";
import { countSkillUses, recentPrompts } from "./audit/usage.js";
import { RECENT_USE_DAYS } from "./core/policy.js";
import { Jev } from "./runtime/jev.js";
import { Store } from "./runtime/store.js";

const PROMPT_LIMIT = 200;
const AUDIT_DEADLINE_MS = 10_000;

const USAGE = `usage:
  token-saver audit [--apply] [--undo]   inventory skills, judge fit, propose settings
  token-saver hook session-start         warn when the setup drifted since the last audit`;

function context() {
  const home = process.env.TOKEN_SAVER_HOME ?? homedir();
  const root = process.env.TOKEN_SAVER_ROOT ?? process.cwd();
  return { home, root, paths: claudePaths(home, root), store: new Store(root) };
}

/** No API key means no client, which means no judgments and so no proposals. */
async function makeJev(cache: Map<string, any>): Promise<Jev> {
  if (!process.env.TYPESAFE_API_KEY) {
    return new Jev({ client: null, cache, deadlineMs: AUDIT_DEADLINE_MS });
  }
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ maxRetries: 0 });
  return new Jev({ client: client as any, cache, deadlineMs: AUDIT_DEADLINE_MS });
}

async function audit(flags: string[]): Promise<number> {
  const { root, paths, store } = context();
  if (flags.includes("--undo")) {
    console.log(undoLast(store));
    return 0;
  }

  const items = scanClaudeCode(paths);
  const since = new Date(Date.now() - RECENT_USE_DAYS * 86_400_000);
  const uses = countSkillUses(paths.transcriptDir, since);
  const profile = buildProfile(root, recentPrompts(paths.transcriptDir, PROMPT_LIMIT));

  const cache = store.loadCache("fit");
  const jev = await makeJev(cache);
  const fits = await judgeFit(jev, profile, items.filter((item) => item.managed));
  store.saveCache("fit", cache);

  const proposals = buildProposals(items, fits, uses);
  console.log(renderProposals(proposals));

  if (flags.includes("--apply")) {
    const count = applyProposals(proposals, paths.settingsPath, store, new Date());
    console.log(`Applied ${count} change(s) to ${paths.settingsPath}.`);
  } else if (proposals.length > 0) {
    console.log("\nRun with --apply to write these, and --undo to revert.");
  }

  store.writeFingerprint(fingerprint(profile, items));
  return 0;
}

function sessionStart(): number {
  const { root, paths, store } = context();
  const items = scanClaudeCode(paths);
  const profile = buildProfile(root, []);
  const current = fingerprint(profile, items);
  const previous = store.readFingerprint();
  if (previous && previous !== current) {
    console.log(
      JSON.stringify({
        systemMessage:
          "token-saver: your skills or project changed since the last audit. Run `token-saver audit`.",
      }),
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "audit") return audit(rest);
  if (command === "hook" && rest[0] === "session-start") return sessionStart();
  console.log(USAGE);
  return 1;
}

// Entry point when run as a binary, not when imported by tests.
if (process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

Note: `audit` writes the fingerprint even without an API key, so `session-start` has a baseline
to compare against. The fingerprint excludes prompts (Task 8), so a plain `audit` and a
`session-start` over the same setup hash identically. The `--apply` path also needs the settings
file's directory to exist; when `.claude/` is missing, create it first with
`mkdirSync(dirname(settingsPath), { recursive: true })` inside `applyProposals` — add that line
if the smoke test in Task 10 hits it.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Add the hook configuration and README**

`src/adapters/claude-code/hooks.json` — what a user merges into their settings:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "token-saver hook session-start", "timeout": 10 }
        ]
      }
    ]
  }
}
```

`README.md`:

````markdown
# token-saver

Cuts an agent's token use by putting small TypeSafe Jev judgments in front of its decisions.
Milestone 1 ships the setup audit for Claude Code.

## Install

```bash
npm install && npm run build && npm link
```

Set `TYPESAFE_API_KEY` in your environment. Without it the audit still runs, but proposes
nothing.

## Use

```bash
token-saver audit            # show proposed skill visibility changes
token-saver audit --apply    # write them to .claude/settings.local.json
token-saver audit --undo     # revert the last applied change
```

Add the `SessionStart` hook from `src/adapters/claude-code/hooks.json` to your settings to be
reminded when your skills or project drift enough to warrant a fresh audit.

The audit never proposes `off`, so every skill stays available as `/name`.

Design: `docs/superpowers/specs/2026-09-17-token-saver-design.md`
````

- [ ] **Step 10: Run the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests PASS, `tsc` completes with no errors.

- [ ] **Step 11: Commit**

```bash
git add src/cli.ts src/adapters README.md tests/cli.test.ts tests/adapters
git commit -m "feat: add audit CLI and SessionStart drift reminder"
```

---

### Task 10: Live smoke test on this machine

**Files:**
- Create: `docs/superpowers/notes/2026-09-17-milestone-1-smoke.md`

**Interfaces:**
- Consumes: the built CLI
- Produces: a note recording real numbers and any disagreements

- [ ] **Step 1: Run the audit against this repository with no key**

```bash
TYPESAFE_API_KEY= node dist/cli.js audit
```

Expected: `No changes proposed.` and exit 0. The audit must never throw when the key is absent.

- [ ] **Step 2: Run it with a key**

```bash
node dist/cli.js audit
```

Expected: a table of this machine's skills with fit levels, usage counts and proposed states.
Nothing is written to settings yet.

- [ ] **Step 3: Check the proposals by hand**

Read every row. For each proposed `user-invocable-only`, confirm you agree the skill is
irrelevant to this project. Confirm that any skill used recently is absent from the table.

- [ ] **Step 4: Apply, verify and undo**

```bash
node dist/cli.js audit --apply
cat .claude/settings.local.json
node dist/cli.js audit --undo
cat .claude/settings.local.json
```

Expected: the file gains a `skillOverrides` object, then returns to its previous content after
the undo.

- [ ] **Step 5: Record the results**

Write `docs/superpowers/notes/2026-09-17-milestone-1-smoke.md` with: the number of skills found,
the estimated tokens saved, how long the audit took, how many Jev requests it made, any proposal
you disagreed with, and whether the undo restored the file exactly.

Disagreements are the input to Milestone 2's thresholds. Record them even when they seem minor.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-09-17-milestone-1-smoke.md
git commit -m "docs: record milestone 1 smoke test results"
```

---

### Task 11: Probe pi's skill mutability (OQ-1)

**Files:**
- Create: `probes/pi-skills/extension.ts`, `docs/superpowers/notes/2026-09-17-oq1-pi-skills.md`

**Interfaces:**
- Consumes: nothing
- Produces: a documented answer to OQ-1, which decides pi's audit adapter in a later milestone

This is a spike. The extension is throwaway; the note is the deliverable.

- [ ] **Step 1: Write the probe extension**

`probes/pi-skills/extension.ts`:

```ts
export default function (pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    const skills = event.systemPromptOptions?.skills;
    console.error(`[probe] skills: ${Array.isArray(skills) ? skills.length : typeof skills}`);
    if (Array.isArray(skills) && skills.length > 1) {
      const removed = skills.splice(1); // keep only the first skill
      console.error(`[probe] removed ${removed.length}: ${removed.map((s: any) => s?.name).join(", ")}`);
    }
    return {};
  });
}
```

- [ ] **Step 2: Run pi with the probe and ask it to list its skills**

```bash
cd probes/pi-skills && pi --extension ./extension.ts -p "List every skill you can see, by name, and nothing else."
```

- [ ] **Step 3: Record the answer**

Write `docs/superpowers/notes/2026-09-17-oq1-pi-skills.md` answering:
- Did `systemPromptOptions.skills` exist, and what shape was it?
- Did removing entries change the skills pi listed in its reply?
- Did pi log a prompt-section patch, or replace the whole system prompt (a cache miss)?
- Verdict: can pi's audit hide skills per session, or must it fall back to filtering package
  skill lists in settings?

If the probe cannot run (pi not installed, flag named differently), record that instead and
leave OQ-1 open. Do not guess the answer.

- [ ] **Step 4: Commit**

```bash
git add probes docs/superpowers/notes/2026-09-17-oq1-pi-skills.md
git commit -m "spike: probe whether pi extensions can hide skills per turn"
```

---

## Self-Review

**Spec coverage (Milestone 1 scope only):**
- Inventory of per-session fixed cost: Task 6, tokens estimated at 4 chars/token.
- Project profile: Task 7 (`buildProfile`, `recentPrompts`, last 200 prompts).
- Usage counts over 30 days: Task 7 (`countSkillUses`), `RECENT_USE_DAYS` in Task 2.
- Fit judgment, four levels, batches of 20: Tasks 3 and 8.
- Fit policy table, never `off`: Task 2.
- Diff / `--apply` / `--undo`: Task 8; CLI surface: Task 9.
- SessionStart reminder that only tells the user and changes nothing: Tasks 8 and 9.
- Fail open, deadlines, redaction, cache: Tasks 1, 4, 5.
- OQ-1 probe: Task 11.
- Deliberately out of scope here: per-prompt hints (Milestone 2), the runtime output filter
  (Milestone 3), P6/P7/P8/G (Milestone 4), and MCP-server/plugin switches (OQ-5 is unresolved,
  so no task writes those settings).

**Placeholder scan:** every step has runnable commands or complete code. No "TBD", no "handle
errors appropriately", no "same as Task N".

**Type consistency:** `InventoryItem`, `SkillState`, `FitLevel`, `Proposal` and `ProjectProfile`
are defined once in Task 1 and used unchanged. `Jev.ask` returns `Record<string, any> | null` in
Tasks 4 and 8. `AuditEntry.previous` is a plain record (never null) in Tasks 5 and 8, so
`undoLast` can treat `previous[id] === undefined` as "did not exist". `claudePaths` returns
exactly the fields `ScanOptions` needs apart from the optional `pluginSkillDirs`, which the CLI
leaves undefined until plugin inventory lands.
