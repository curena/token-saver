# token-saver: design

Date: 2026-09-17
Status: implemented (G); C deferred
Harness: pi (pi coding agent, `@earendil-works/pi-coding-agent` 0.85.1)

## 1. Problem

A coding agent resends its whole conversation on every model call. Large tool
results stay in that conversation long after the agent has finished using them,
and the agent pays for them on every later call until compaction throws them
away wholesale.

Measured over the 35 pi sessions in `~/.pi/agent/sessions` (2.4 MB, 370 tool
results):

| Tool | Calls | Median chars | p90 | Max | Results > 8k chars |
|---|---|---|---|---|---|
| `bash` | 265 | 365 | 2 492 | 18 880 | 4 |
| `read` | 42 | 6 294 | 30 875 | 50 939 | 14 |
| `grep` / `find` / `ls` | 0 | — | — | — | — |
| other (memory, edit, write) | ~60 | < 500 | — | — | 0 |

42 `read` results carry more text than 265 `bash` results. Eight compactions
fired across those sessions. File reads are the bloat, and compaction is the
only thing currently addressing them.

## 2. Approach

Use TypeSafe's Jev model as a cheap judgment ahead of each model call, in the
style of <https://docs.typesafe.ai/cookbooks/skill_suggestion>: a small model
reads everything so the expensive model doesn't have to.

Jev costs $0.042 per Mtok of input and charges nothing for output
(`jev-1.13.0`), which is 25–350x cheaper per input token than the models pi
drives. Judging every chunk of a large result individually is therefore
affordable.

Two features were identified. This spec covers **G** in full; **C** is
deferred and sketched in section 11.

- **G — stale-result pruning.** Before each model call, replace tool results
  the agent no longer needs with a stub or with only their still-relevant
  lines. Covers the `read` bulk above, with low risk because the results are
  already old.
- **C — output filtering.** Shorten a large result as it is produced. Deferred:
  in the measured history it would mostly fire on `bash` results that are
  already small, and filtering a fresh `read` risks breaking the `edit` that
  usually follows it.

### Selection, never generation

Jev returns typed judgments, not text. Every line the agent sees is copied
verbatim from the original result. The extension can drop content, never invent
it.

### Recoverability

Anything removed stays reachable. Each stub carries the `toolCallId` of the
original, and a registered `recall` tool returns the original text (optionally
a line range) out of the session file. Recall counts are the primary signal
that the thresholds are too aggressive.

### Prompt-cache discipline

Editing history invalidates the provider's prompt cache from the edit point
onward, so the suffix is re-written at cache-write prices. Three rules follow,
and they drive most of the design:

1. A result's treatment is decided **once** and applied identically on every
   later call (byte-for-byte stable between sweeps).
2. Sweeps are **batched and rare**, gated by an explicit cost check
   (section 6).
3. `recall` **never reverts a stub**; it appends the original as a new tool
   result at the end of the conversation, which leaves the cached prefix
   intact. Only the explicit `/token-saver restore <id>` command reverts, at
   the cost of one cache reset.

## 3. Architecture

One repo, npm workspaces, TypeScript. `core` has no pi imports, so the offline
replay harness and the live extension run the same code.

```
packages/
  core/       no pi imports: pure functions + Jev client
    chunk/      split a result into chunks -> [{id, lines, text}]
    judge/      Jev questions (one request per result, one noul per chunk)
    policy/     eligibility, staleness rules, three-level decision, cost check
    render/     stub and partial rendering, gap markers
  pi/         extension: context handler, recall tool, sweep state, commands
  replay/     CLI: session .jsonl -> core -> savings + retention report
```

Rejected alternatives: a single monolithic pi extension (ties the logic to pi's
event types and forces the replay harness to fake pi objects); a local HTTP
sidecar shared with other harnesses (extra process, per-call latency, not worth
it before G is shown to pay off).

## 4. Data flow (pi extension)

On every `context` event (fired before each LLM call; `event.messages` is a
deep copy, safe to modify):

1. **Collect** tool results from `event.messages`, pairing each with its
   originating call (tool name, input), its position, and an estimated token
   count.
2. **Apply saved decisions.** Any result whose `toolCallId` is in the decision
   map is replaced with its stored rendered text. Deterministic, so the
   history is identical between sweeps.
3. **Check triggers** (section 6). If neither fires, return. This is the common
   path and costs microseconds.
4. **Sweep** (section 5) if triggered.
5. **Persist** all decisions from the sweep as one
   `pi.appendEntry("token-saver/sweep", { decisions })`, then return the
   modified messages.

State is rebuilt on `session_start` and `session_tree` by scanning the current
branch for `token-saver/sweep` entries, so restarts, forks and tree navigation
work without extra bookkeeping. After a compaction, decisions for entries
before `firstKeptEntryId` are irrelevant and dropped.

Failure is always fail-open — the model call proceeds with the unmodified
context:

- Jev error, rate limit, or exceeding `jevBudgetMs` (1500 ms per sweep):
  abandon the sweep, change nothing, retry at the next trigger.
- `ctx.signal` aborting (user pressed Esc): abandon the sweep.

## 5. A sweep

### 5.1 Eligibility (code)

A result is eligible when all hold:

- older than the last `protectTurns` user turns (default 2)
- at least `minResultTokens` (default 1500)
- not an error (`isError`)
- no decision recorded yet
- not `recall` output from the last `protectTurns` turns
- role is `toolResult`; tool is not `edit` or `write`

User messages, assistant messages and thinking are never touched.

### 5.2 Code-decided staleness

A `read` whose path was later edited, written, or read again is superseded: its
content no longer matches the file. Stub it without consulting Jev.

### 5.3 Jev judgment

One request per remaining eligible result; every chunk is judged in parallel
inside that request.

Chunking (`core/chunk`, code only):

- `read`: split at blank lines and top-level declarations, 20–60 lines per
  chunk, preserving the file's real line numbers even for offset reads.
- `bash`: split at blank lines and where the line pattern changes (e.g. a test
  summary versus a stack trace), 20–40 lines per chunk.
- other tools: fixed 40-line windows.

```ts
state = {
  task: {
    recent_user_messages,   // last 2, truncated
    latest_assistant_text,  // truncated
    working_files,          // paths edited/written in the last K turns
  },
  result: { tool, input },  // e.g. "read src/app.ts", or the bash command
  after_result,             // brief summary of the agent's actions after this result
  chunks: [{ lines: "120-168", text }, ...],
}

questions["chunk::<i>"] = noul({
  instructions:
    "Given the agent's current task, will it need to look at the text of " +
    "`chunks[<i>]` again to finish, for example because it contains code it " +
    "will change or call, an error it is still fixing, or a value it must reuse?",
  criteria: {
    true:  "Still needed for work that remains",
    false: "Background already used, or unrelated to what remains",
  },
})
```

`after_result` is the load-bearing input: a result the agent has already acted
on (read a file, then edited it) looks very different from one it has not used
yet. Without it the question degrades into topic relevance, the failure the
cookbook warns about, where "explain what a monad is" reads as a software
request.

### 5.4 Three-level decision (`core/policy`)

With keep threshold `τ` (`keepThreshold`, default 0.3):

- every chunk below `τ` -> **stub**
- kept chunks are >= `leaveAloneRatio` (0.7) of the result's tokens -> **leave
  alone** (a partial would save little and add gap markers)
- otherwise -> **partial**: keep chunks at or above `τ`, merge adjacent kept
  chunks, mark the gaps
- either way, if the saving is under `minSaving` (500 tokens) -> leave alone

`τ` is deliberately low: keeping a chunk unnecessarily wastes a few tokens,
dropping one the agent needs costs a recall plus a round trip. Replay tunes it
against that asymmetry.

### 5.5 Rendering (`core/render`)

Stub:

```
[token-saver] read src/app.ts: 412 lines (~9.8k tok) elided as no longer needed. recall({id:"call_83"}) to restore; startLine/endLine for part.
```

Partial:

```
[token-saver] read src/app.ts: showing lines still relevant; recall({id:"call_83", startLine, endLine}) for gaps.
 118| export function handler(req) {
 ...
… lines 169–340 elided …
 341| ...
```

## 6. Triggers

### 6.1 Cost check

Runs in code on every `context` event, before any Jev request, using the
current model's prices from `ctx.model.cost` (`input`, `cacheRead`,
`cacheWrite`).

- `S` — tokens the sweep would save. Code-decided stale results count in full;
  results Jev has yet to judge count at `expectedSaveRatio` (`r`, default 0.5)
  of their size.
- `T_after` — tokens from the earliest changed result to the end of the
  conversation; this suffix is re-written to cache once.
- `N` — model calls expected in the remainder of the session, estimated as
  `clamp(callsSoFar, 3, 40)`.

With caching:

```
value = S × N × cacheRead
cost  = (T_after − S) × (cacheWrite − cacheRead)
sweep when value >= costMargin × cost          // costMargin default 1.5
```

**Choice of starting point.** Sweeping from an early result means re-writing
almost the whole conversation. Code therefore evaluates each eligible result as
the earliest changed position, counting only that result and later ones, and
picks the position maximising `value − cost`. One pass over the candidate list.

Worked examples (per Mtok: input $3, cacheRead $0.30, cacheWrite $3.75):

- 20k stubbable behind a 60k suffix, 15 calls left: value 90k units vs cost
  138k -> no sweep.
- 40k stubbable (three large reads) behind a 50k suffix, 20 calls left: value
  240k vs cost 35k -> sweep.

Pruning pays off when large results pile up; scattered small results are left
alone.

Without cache pricing (provider has no prompt caching): nothing is re-written,
so sweep when `S >= 4k` tokens.

**Re-check after Jev.** Real savings usually differ from the estimate. The same
check runs on the actual numbers; if the sweep no longer clears the bar, the
decisions are **discarded rather than persisted**, and a 3-turn cooldown stops
the same results being re-judged on every call.

### 6.2 Context-limit trigger

- Condition: `ctx.getContextUsage()` >= `contextLevel` (default 0.60,
  configured below pi's auto-compaction threshold).
- Effect: sweep without the cost check, with eligibility relaxed to results
  older than 1 turn.
- Re-arming: fires again only after usage grows another 10 percentage points,
  or new eligible results appear, so a context with nothing to prune does not
  sweep on every call.
- Rationale: the cost check only counts money. A near-full context also means
  degraded answers, higher latency, and an imminent compaction that discards
  far more than a sweep would.

### 6.3 Token estimation

4 characters per token, calibrated by comparing the estimate against the input
token count pi recorded for the previous model call.

## 7. Agent-facing surface

**Prompt guideline**, added once per session in `before_agent_start` via
`systemPromptOptions.promptGuidelines` (pi patches only changed sections, so
the cached prompt survives). Added once, not per sweep:

> Older tool results may appear shortened, marked `[token-saver] … elided …`.
> The full text is still available: call `recall` with the id shown to get it
> back, with optional `startLine`/`endLine`. Recall when you need details, and
> don't guess at elided content.

**`recall` tool**, registered at session start via `pi.registerTool`:

```ts
{
  name: "recall",
  description:
    "Restore the full text of a tool result that token-saver shortened. Use the id from " +
    "a [token-saver] marker. startLine/endLine fetch part of a file read. Call this " +
    "instead of guessing, or re-running the command, when you need elided detail.",
  parameters: { id: string, startLine?: number, endLine?: number },
}
```

It reads the original from `ctx.sessionManager`, logs the recall, and returns a
normal tool result appended at the end of the conversation. A later sweep may
shorten that result in turn.

**Terminal display**: each sweep writes one display-only line via
`pi.appendEntry` plus `pi.registerEntryRenderer` (custom entries never enter
LLM context):

```
◆ token-saver  3 results shortened · ~24.1k tokens freed · 0 recalls this session
```

**Commands** (`pi.registerCommand`):

- `/token-saver` — what has been shortened, tokens freed, recalls, Jev spend
- `/token-saver off` | `on` — stop or resume sweeps; existing stubs remain,
  since reverting resets the cache
- `/token-saver restore <id>` — revert one stub, accepting one cache reset

## 8. Configuration

Read from `~/.pi/token-saver.json`, then `.pi/token-saver.json` in the project,
then `TOKEN_SAVER_*` environment variables. `TOKEN_SAVER=off` disables the
extension entirely.

| Setting | Default | Meaning |
|---|---|---|
| `minResultTokens` | 1500 | Smaller results are never touched |
| `protectTurns` (K) | 2 | Results from the last K user turns are never touched |
| `keepThreshold` (τ) | 0.3 | Chunks at or above this are kept verbatim |
| `leaveAloneRatio` | 0.7 | Keeping this share of tokens means leaving the result alone |
| `minSaving` | 500 | Below this saving, make no change |
| `costMargin` | 1.5 | Required ratio of value to cache cost |
| `contextLevel` | 0.60 | Forced-sweep level |
| `expectedSaveRatio` (r) | 0.5 | Assumed saving before Jev answers |
| `jevBudgetMs` | 1500 | Over budget, abandon the sweep |
| `jevModel` | `jev-1.13.0` | Pinned; thresholds are tuned per model version |

The TypeSafe API key comes from `TYPESAFE_API_KEY`. Missing key means the
extension stays inert and says so once.

## 9. Measurement

### 9.1 Unit tests (`core`, no network)

Chunk boundaries on recorded fixtures; the cost check's arithmetic including
starting-point selection; the three-level decision at threshold edges;
rendering and line-number fidelity; state rebuilt after branching and
compaction. Jev answers come from fixtures.

### 9.2 Replay (phase 1)

```
token-saver-replay ~/.pi/agent/sessions --tau 0.1,0.2,0.3,0.5 --report out/
```

Walks each session's entries in order and, at each point where a model call
occurred, rebuilds the context pi would have built, then runs the real `core`
over it with that call's model and prices. Jev answers are cached in a JSON
file keyed on their inputs (as the cookbook's `JsonCache` does), so re-runs are
free.

Reported:

1. **Tokens and money** — context tokens per call with and without the
   extension, and estimated cost including cache writes, per session and in
   total.
2. **Retention (the safety metric)** — for every elided chunk, whether the
   agent later used that text: the chunk's lines appearing in later assistant
   text, in a later `edit`'s before/after text, or in a later command, and
   whether those lines were later edited. Each such chunk is a **miss**,
   reported with the Jev probability that allowed it through.
3. **Sweep behaviour** — sweeps per session, results stubbed / partial /
   untouched, Jev requests, Jev cost, added latency per sweep.
4. **A `τ` curve** — savings against misses per `τ`, which sets the default.

Limitation: the recorded sessions had the full text present, so replay cannot
show behavioural change. A miss means the agent would probably have needed a
recall — one round trip, not a failure. Phase 2 covers the rest.

### 9.3 Live A/B (phase 2)

- Tasks: ~12, each a repo at a fixed commit, a prompt, and a verification
  command; deliberately including long multi-file tasks, where G acts.
- Runs: pi headless, with and without the extension, 3 runs per task per arm,
  same model.
- Measures: input / output / cache-read / cache-write tokens and cost; tests
  passing; wall-clock; recall calls; sweeps; compactions avoided.
- Proposed bar for shipping: on the long tasks, total cost down >= 20%; pass
  rate no worse allowing for run-to-run variance, with no task consistently
  flipping pass -> fail; fewer than 1 recall per 10 results shortened.

Ordering: unit tests and replay first, thresholds set against the existing 35
sessions; the A/B test is separate work after G runs live, since the task set
must be built.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Stubbing costs more than it saves through cache resets | Explicit cost check with a 1.5x margin; starting-point optimisation; sticky decisions; recall appends instead of reverting |
| The agent needs elided content | Low `τ`; `protectTurns`; `recall` with line ranges; retention metric and recall counts as feedback |
| Jev misjudges relevance | `after_result` in state; asymmetric threshold; replay-tuned per model version; fail-open on error |
| Added latency per model call | Sweeps are rare; `jevBudgetMs` 1500; one request per result, chunks judged in parallel |
| Decision state diverging from the session tree | State rebuilt from branch entries on `session_start` / `session_tree`; decisions keyed by `toolCallId` |
| A fresh `read` being pruned before an `edit` | Out of scope for G: `protectTurns` keeps recent results intact; this is C's problem, deferred |

## 11. Deferred: C (output filtering)

Same core, a `tool_result` handler in `packages/pi` (pi lets `tool_result`
rewrite a built-in tool's content). The judgment differs: there is no
`after_result`, so the query is the agent's *intent* — the latest user prompt,
the assistant text just before the call, and the tool input. Code always passes
through errors, exit codes, and a tail of the output.

Scope when built: `bash` first; `read` only when the file is large and the
intent is inspection rather than editing, since pi's `edit` requires exact
text. Sequencing decision (2026-09-17): G first, because the measured history
shows the bulk is old `read` results, where the edit-exactness risk is much
lower.

Not planned for now, from the original brainstorm: per-turn tool selection and
answer-length control (A, B), tool-call rewriting (E), and a Claude Code
adapter. `core` stays free of pi imports so these remain possible.

## 12. Non-goals

- Summarising or rewriting content in prose; content is selected verbatim only.
- Replacing pi's compaction. G delays it; it does not replace it.
- Editing user or assistant messages.
- Cross-session or cross-harness shared state.
