# token-saver design

Date: 2026-09-17

## Summary

token-saver puts small TypeSafe Jev judgments in front of an agent's decisions so the agent
spends fewer tokens. It has two halves that share one core:

1. **Setup audit** — an offline command that finds the fixed per-session cost of skills,
   plugins and MCP servers, judges how well each fits the project, and proposes settings
   that hide the ones that do not fit. A per-prompt hint makes up for the hidden
   descriptions.
2. **Runtime** — hooks that shrink large tool output to the parts that serve the current
   goal, keeping the rest in a recall file, plus a few small per-prompt judgments.

Both halves are measured by a test set built from the user's own sessions. Nothing ships
that makes the agent's choices worse.

The approach is taken from TypeSafe's
[skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion): read
everything cheaply with Jev, read a few candidates properly, and give the agent one line it
is free to ignore.

Targets: [pi](https://pi.dev) (extensions) and Claude Code (hooks). Shared core, thin
adapters.

## Goals

- Cut tokens per session without making the agent worse at its job.
- Keep every judgment recoverable: anything hidden can be read back.
- Fail open. A broken or slow judgment must never change what the agent sees.
- Measure before shipping, on the user's own prompts.

## Non-goals

- Replacing the agent's judgement. token-saver suggests and filters; it never answers.
- Summarising or rewriting content. Filters select spans of the original text only.
- Cross-machine or hosted state. Everything is local files.
- Supporting harnesses beyond pi and Claude Code in the first version.

## Decisions taken during design

| Decision | Choice | Why |
| --- | --- | --- |
| Harness support | Shared core, thin adapters | pi is primary; Claude Code has its own problems worth solving |
| Validation | Test set built from the user's own sessions | The cookbook's method; the only way to catch quality regressions |
| Privacy | Redact locally, then send | Tool output carries secrets; masking does not change relevance |
| Audit application | User runs it; diff, `--apply`, `--undo`, plus a reminder | Settings changes persist across sessions and must be visible |
| Integration shape | Command-line tool per hook call, state in files | No daemon lifecycle; a background service can wrap the same library later |
| MCP server | Ruled out | Its tool definitions add to the fixed cost the audit exists to remove |

## Problems addressed

| # | Problem | Mechanism |
| --- | --- | --- |
| P1 | Fixed per-session cost: skill listings, plugin-injected context, MCP instructions | Setup audit |
| P2 | Hidden descriptions weaken skill selection | Two-step Jev suggestion, one line injected per prompt |
| P3 | Deferred-tool lookups cost extra round trips (Claude Code) | `ToolSearch select:` hint (deferred, see Open questions) |
| P4 | Large `bash`, `grep` and web output | Result filter with recall |
| P5 | Whole-file reads | Same result filter, applied to `read` |
| P6 | Stale context cannot be pruned in Claude Code | Prevention (P4/P5) plus a topic-switch warning to the user |
| P7 | Subagents spawned for narrow tasks | One Noul at the tool call; off by default |
| P8 | Answers longer than the question warrants | Answer-shape line injected per prompt |
| G  | Stale tool results in a long session (pi only) | Prune on pi's `context` event, replacing with recall markers |

## Architecture

```
token-saver/
  src/core/                 pure logic: no fs, no network, no clock
    questions/
      rank.ts               Choice over candidates (skills, deferred tools)
      gate.ts               Nouls: does this turn need a skill/tool at all?
      focus.ts              per-chunk Nouls: which chunks serve the goal
      fit.ts                Score: how well an item fits this project
      relevance.ts          Noul: does this prompt depend on the earlier conversation?
    chunk.ts                split output/files into line-range chunks
    redact.ts               mask secrets, apply path denylist, map offsets back
    policy.ts               thresholds and decisions
    types.ts                Event, Decision, Candidate, Chunk, Goal
  src/runtime/              the I/O edge
    jev.ts                  SDK wrapper: deadline, no retries, redaction, cache, usage log
    store.ts                .token-saver/{recall,cache,audit,log}
    goal.ts                 current goal from the session transcript
  src/adapters/
    claude-code/            `token-saver hook <event>`, hooks.json, plugin manifest
    pi/                     extension: before_agent_start, tool_call, tool_result, context
  src/audit/                `token-saver audit [--apply|--undo]`, fingerprint
  eval/                     case builder, runner, report
```

Runtime: TypeScript on Node 20 or newer (required by `@typesafe-ai/sdk` v0.6), shipped as
one npm package with a Claude Code plugin and a pi extension inside it.

### Data flow

1. The adapter converts a harness event into a core `Event`: prompt submitted, tool about to
   run, tool finished, or context about to be sent.
2. `goal.ts` attaches the current goal, read from the session transcript (the most recent
   user prompt, and the assistant text that frames it).
3. `policy.ts` decides in plain code whether a judgment is needed at all. Most events stop
   here: small output, denylisted path, unhandled tool, unknown goal.
4. A question builder produces the request. `jev.ts` redacts it, checks the cache, applies
   the deadline, and sends it.
5. `policy.ts` turns the answers into a `Decision`, for example *keep lines 40-88 and
   310-342, recall id `r_7f3a`*.
6. The adapter writes the decision back in the harness's own format.

Keeping `core` free of I/O is what allows a later background-service integration to reuse it
unchanged, and lets `policy` be unit-tested without network access.

### Harness capabilities

| Capability | pi | Claude Code |
| --- | --- | --- |
| Inject context per prompt | `before_agent_start` (message or prompt sections) | `UserPromptSubmit` `additionalContext` |
| Modify tool input | `tool_call` (mutable `event.input`) | `PreToolUse` `updatedInput` |
| Block a tool call | `tool_call` `{ block: true, reason }` | `PreToolUse` deny |
| Replace tool output | `tool_result` return patch | `PostToolUse` `updatedToolOutput` (must match the tool's output shape) |
| Edit conversation history | `context` event | not available |
| Change active tools/skills for a turn | `before_agent_start` `systemPromptOptions` | not available |
| Startup message to the user | extension output | `SessionStart` `systemMessage` |

Sources: pi `docs/extensions.md`, Claude Code hooks reference (both read 2026-09-17).

## Setup audit (P1)

### Inventory

Per harness, every fixed-cost item with its source and token cost:

- Claude Code: personal skills, project skills, plugin skills, context injected by plugins at
  `SessionStart`, MCP server instructions and tool counts, the deferred-tool name list.
- pi: skills from settings, packages and project directories.

Costs are measured from real transcripts where the text can be attributed (injected hook
context, the skill listing) and estimated from the item's text otherwise.

### Project profile

Built by code, with no model involved:

- the opening of the README,
- dependency manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, …),
- the top-level file tree,
- the last 200 redacted user prompts from this project's sessions,
- per item, how many times it was used in the last 30 days.

### Fit judgment

One Jev `Score` per item against the profile, batched about 20 items per request, with
levels:

1. core to this project's work
2. likely useful now and then here
3. general-purpose, unrelated to this project
4. irrelevant here

Policy, combining fit with usage:

| Condition | Proposed state |
| --- | --- |
| Used in the last 30 days | `on` |
| Fit level 1 | `on` |
| Fit level 2 or 3 | `name-only` |
| Fit level 4 and unused | `user-invocable-only` |

The audit never proposes `off`, because `off` also hides the skill from the user's own `/`
menu. Plugin skills are not covered by `skillOverrides`; for those, and for MCP servers, the
audit reports a recommendation and applies it only where a per-project setting has been
confirmed to exist.

### Diff, apply, undo

`token-saver audit` prints one row per item: item, source, tokens, fit, uses, current state,
proposed state, plus an estimated saving per session. `--apply` writes:

- Claude Code: `skillOverrides` in `.claude/settings.local.json`.
- pi: `.pi/token-saver.json`, read once per session by the extension, which drops or collapses
  skills in `systemPromptOptions`. Applying once per session keeps the prompt cache intact.
  Depends on **OQ-1**.

Every write records the previous value in `.token-saver/audit/log`; `--undo` restores it.

### Reminder

A `SessionStart` command hook hashes the profile inputs and the inventory. On a change it
emits a `systemMessage` to the user ("2 skills installed since the last audit; run
`token-saver audit`"). It never writes to Claude's context and never changes settings.

## Per-prompt judgments (P2, P6, P8)

One request carries the questions that share the same state, as the cookbook does:

- **Skill ranking** — `Choice` over every skill the agent may still invoke, with the index
  description as each option's criteria; plus three `Noul` gate questions on whether the turn
  needs a skill at all. Below the gate threshold, nothing is suggested.
- **Conversation dependence** (P6) — one `Noul`. When the context is large and the answer is
  low, a `systemMessage` suggests `/clear` **to the user**. Nothing is said to the agent.
- **Answer shape** (P8) — a `Choice` over: quick fact, yes/no, code change, explanation,
  design discussion. It produces at most one short line.

A second request re-reads the top 3 skills with their full descriptions and the opening of
their instructions: a `Choice` over the shortlist plus one `Noul` per candidate asking
whether that skill does the specific thing asked for. A shortlist whose best `Noul` is below
the threshold is dropped.

The injected block follows the cookbook:

```
<skill_relevance>
Relevant to the current request: <name>. Ignore this if it does not fit what the user
actually asked for.
</skill_relevance>
```

Nothing is injected when there is no suggestion. Whether an explicit "no skill applies" line
does better is decided by the test set.

Injection points: `UserPromptSubmit` `additionalContext` (Claude Code), `before_agent_start`
message (pi). Both land after the cached prompt, so the roster's prefix cache still holds.

## Runtime filter (P4, P5)

Runs on `PostToolUse` (Claude Code) and `tool_result` (pi) for `bash`, `read`, `grep` and web
fetches.

1. **Cheap checks, in code.** Pass through when the output is under the threshold (about 150
   lines or 4KB), the path is denylisted, the tool is unhandled, or the goal is unknown.
2. **Chunking.** Line ranges that follow the content's structure: per test case in test
   output, per frame group in a stack trace, per file in grep output, per top-level block in
   source. Chunks keep their original line numbers.
3. **Judgment.** One `Noul` per chunk — does this chunk contain what the goal needs — batched
   about 25 per request, in parallel, capped at 4 requests. Beyond the cap, heuristics choose
   the candidate chunks first.
4. **Assembly, in code.** Always keep the first and last 20 lines, the exit status, and lines
   matching the error pattern. Add chunks above the threshold, merge adjacent ranges, and cap
   the result at 200 lines or 40% of the original, whichever is smaller.
5. **Replacement.** The tool's output shape is preserved, with one marker line:
   `[token-saver] lines 1-20, 44-96, 310-330 of 1482 · full output: .token-saver/recall/r_7f3a.txt`
6. **Recall.** The original goes to that file, read back with the tools the agent already has,
   so no tool definition is added. Every recall is logged; a high rate means the thresholds are
   too aggressive.

P5 is this same filter applied to `read`. An earlier draft blocked the call and returned line
ranges; filtering the result instead costs no extra turn and keeps the file's own line
numbers.

## Subagent gate (P7)

`PreToolUse` on `Agent` (Claude Code) and `tool_call` on the subagent tool (pi): one `Noul`
asking whether the task needs a broad search across many files. Below the threshold the call
is blocked with a one-line reason. **Off by default**; enabled only if the test set shows a
gain.

## History pruning (G, pi only)

On pi's `context` event, each tool result older than 10 turns and above the size threshold gets
a `Noul`: is this still needed for the current goal? Results that are not become the marker
line, with the text in the recall store. Decisions are cached per tool call id and revisited
only when the goal changes. This edits the copy sent to the model, never the saved session.

## Cross-cutting rules

- **Fail open.** Any error, timeout, missing API key or malformed hook input means the
  original passes through unchanged.
- **Deadlines.** Every Jev call uses `maxRetries: 0` and a firm deadline: 300ms for prompt
  hooks, 800ms for tool results. Past the deadline, the original is used.
- **Never filter** `Edit` or `Write` results, denylisted paths, or output below the threshold.
- **Kill switch.** `TOKEN_SAVER=off` disables every hook; `TOKEN_SAVER_MODE=shadow` runs the
  full pipeline and logs what it would have done without changing anything.
- **Redaction before every call.** Known key formats, high-entropy strings, `.env` values, and
  a path denylist (`.env*`, `*.pem`, `id_*`, `secrets/**`). Masking applies only to what is
  sent; the agent always receives spans of the unmasked original.
- **Caching.** Jev results are cached by a hash of their inputs under `.token-saver/cache`.

## Measurement

`token-saver eval build` reads `~/.claude/projects/` and `~/.pi/agent/sessions/` and writes
redacted cases to `eval/cases/`, git-ignored by default.

- **Selection cases:** a prompt plus the skill invoked right after it. Prompts with no
  invocation become candidate negatives, counted only after the user confirms them.
- **Output cases:** a tool call, its full output, and the goal at the time; replayed offline.
- **Task cases:** a few small end-to-end jobs in a scratch repository, run live.

Two suites:

1. **Selection** — each prompt through `claude -p --output-format json` and pi's equivalent,
   in three variants: current setup, audit applied, audit plus hints. Reports wrong loads,
   unneeded loads, fixed prompt tokens, total input and output tokens, cache reads.
2. **Runtime** — output cases report kept fraction, whether the lines the original session
   went on to use survived, and the would-be recall rate. Task cases report tokens, turns and
   success.

Each case runs 3 times; the report gives means with a paired bootstrap confidence interval
per variant. Differences inside the interval count as no difference. Every Jev and agent call
is cached by its inputs, so re-reporting is free; `--estimate` prints expected cost before a
live run.

### Ship criteria

| Measure | Requirement |
| --- | --- |
| Wrong skill loads | No worse than the current setup, within the interval |
| Unneeded skill loads | No worse than the current setup |
| Fixed tokens per session | Lower, by a margin the audit reports |
| Needed lines dropped by the filter | Under 2% of output cases |
| Recall rate | Under 10% of filtered results |
| Task success | Unchanged |
| Input tokens on long-output tasks | Lower, outside the interval |

All thresholds in `policy.ts` are tuned on these numbers. The filter runs in shadow mode until
the output cases clear the criteria.

## Milestones

1. **Core plus audit.** `core/questions/fit.ts`, `redact.ts`, `policy.ts`, `runtime/jev.ts`,
   `store.ts`, the inventory and profile builders, `token-saver audit` with diff, apply and
   undo, and the `SessionStart` reminder. Claude Code first, pi once OQ-1 is settled.
2. **Selection suite plus hints (P2).** Case builder, selection runner, report, then the
   two-step suggestion hook in both harnesses. The audit's collapsing levels are set here.
3. **Runtime filter (P4, P5).** Chunking, `focus.ts`, assembly, recall store, adapters for
   both harnesses, shadow mode, and the runtime suite.
4. **The small ones.** P6 topic-switch warning, P8 answer shape, P7 subagent gate, G history
   pruning on pi.

## Open questions

- **OQ-1:** Does editing `systemPromptOptions.skills` in pi's `before_agent_start` actually
  change the skills listed in the prompt? The docs say the collections are mutable but name
  only `sections`, `selectedTools` and `promptGuidelines` as preferred. Resolve with a small
  probe against a local pi before milestone 1's pi adapter. If it does not work, pi's audit
  falls back to filtering package skill lists in settings, which is coarser.
- **OQ-2:** Claude Code hooks do not receive the deferred-tool list, so P3 needs the tool
  descriptions from somewhere: listing the MCP servers directly, or caching what `ToolSearch`
  returns during sessions. P3 stays out of scope until this is settled.
- **OQ-3:** TypeSafe does not publish a maximum request size. Batch sizes (20 items for fit,
  25 chunks for focus) are starting points to be checked against the real limit and against
  latency.
- **OQ-4:** Claude Code's `updatedToolOutput` must match each built-in tool's output shape, and
  a mismatch is silently ignored. The shape for every filtered tool must be confirmed against
  the running version before milestone 3.
- **OQ-5:** Per-project switches for MCP servers and plugins need confirming before the audit
  writes anything for them; until then it only reports.
