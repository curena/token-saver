# Reconciling the two token-saver branches

Date: 2026-09-27
Status: analysis and recommendation, not yet acted on

Resolves the carry-forward that has been open since the specs diverged: two
branches, two specs, two things called `core`, and no written account of how
they fit together. Written from a read of both trees at
`worktree-milestone-1-plan` @ `b6a26e6` and `token-saver-g` @ its tip.

## 1. The two branches are different products, not two harnesses

The framing "one of these is the pi version" is wrong and worth retiring
explicitly, because it makes the layout question unanswerable.

| | `worktree-milestone-1-plan` | `token-saver-g` |
|---|---|---|
| Product | Setup audit | Runtime stale-result pruning |
| Spec | `2026-09-17-token-saver-design.md` | `2026-09-17-token-saver-g-design.md` |
| Runs | Between sessions, user-invoked | Mid-session, before each model call |
| Acts on | `skillOverrides` in a settings file | Tool results in the live context |
| Domain types | `InventoryItem`, `SkillState`, `Proposal` | `ResultRef`, `Chunk`, `Level`, `Decision` |
| Jev question | `Score`, ordered 4-level rubric | `Noul`, true/false criteria |
| Harness | Claude Code | pi |
| Layout | flat `src/` | workspaces, `packages/{core,pi,replay}` |

They overlap in three files' worth of code (§4) and in nothing else.

## 2. The specs do not actually conflict

This was the worry. It does not survive reading them next to each other.

The design spec describes "two halves that share one core": (1) the setup
audit, (2) a runtime that shrinks large tool output. The g spec covers
feature **G — stale-result pruning**, which *is* half 2, and says so. Its §11
defers feature **C — output filtering**, and closes with:

> Not planned for now, from the original brainstorm: per-turn tool selection
> and answer-length control (A, B), tool-call rewriting (E), and a Claude Code
> adapter. `core` stays free of pi imports so these remain possible.

So the g branch already reserves room for a Claude Code adapter and already
keeps its core harness-neutral. Milestone 1 built half 1 for Claude Code. The
two branches are the two halves of one design, built in parallel from opposite
ends. No architectural decision needs reversing.

What *is* genuinely unresolved is naming and layout.

## 3. The word "core" is overloaded

Both trees use it, for different things:

- `worktree-milestone-1-plan/src/core/` — audit domain: `policy.ts`,
  `questions/fit.ts`, `redact.ts`, `types.ts`.
- `token-saver-g/packages/core/` — pruning domain: `chunk.ts`, `sweep.ts`,
  `judge.ts`, `render.ts`, `policy/{budget,cost,decide,eligibility,staleness}.ts`.

Neither is the "one core" the design spec means. `packages/core` is not a
neutral layer the audit could sit on; it is the pruner's own domain logic,
and an audit built on it would be inheriting `ResultRef` and `Chunk` for
nothing.

## 4. The genuinely shared surface is three files

Not a layer. Three files, and they should be the entire contents of a real
shared package.

**`tokens.ts` — already duplicated.** `estimateTokens` exists in both. The g
version is strictly better: configurable `charsPerToken`, a `max(1, …)` floor,
and `calibrateCharsPerToken` for fitting the ratio to observed samples. The
audit's `Math.ceil(text.length / 4)` should be deleted in its favour. Note
that the audit's `estimateTokens` is load-bearing for the savings arithmetic
fixed in `1d75a60`, so this swap needs its tests re-run, not just a rename.

**The Jev client wrapper.** Both wrap `systemOne` with a deadline and
fail-open-to-null. `src/runtime/jev.ts` additionally does caching, a usage
callback, and recursive redaction of `state`; `packages/core/src/judge.ts` is
a thinner `buildRequest` plus a `JevClient` interface. The audit's is the more
complete wrapper and should be the surviving one.

**`redact.ts` — audit only.** See §5.

Everything else stays in its own product package.

## 5. The redaction gap, which is a merge blocker

`git grep -il "redact\|denylist\|mask"` across `token-saver-g/packages/`
returns nothing. The g spec does not mention redaction; the only spec that
does is the design spec, which sits on that branch unused by its code.

This matters far more for the pruner than for the audit, and the design spec
says why in its own constraints table (line 48):

> | Privacy | Redact locally, then send | **Tool output carries secrets**; masking does not change relevance |

The rationale names tool output specifically. The audit sends skill names and
descriptions — public strings out of `SKILL.md` files. The pruner sends the
text of tool results: file contents, command output, whatever `read` and
`bash` returned. The requirement was written for the half that does not
implement it.

The standing constraint in full, as stated: *redact locally, then send — mask
known key formats, high-entropy strings, `.env` values; skip files matching
the denylist `.env*`, `*.pem`, `id_*`, `secrets/**`; the lines Claude gets
back come from the original output, not the masked copy.* That last clause
reads as though it was written with chunk recall in mind, which is the
pruner's design, not the audit's.

**The fix is nearly free if the extraction happens first.** `src/runtime/jev.ts`
already redacts everything in `state` recursively (`redactDeep`, jev.ts:88).
The pruner puts tool-result text in `state`. So a pruner built on the audit's
wrapper inherits redaction by construction rather than by remembering.

One caveat to carry across, documented at `jev.ts:55` and `fit.ts:47`: the
wrapper redacts `state` and deliberately *not* `questions`, because redacting
a built question object would couple redaction to SDK internals. Any question
builder must redact what it interpolates into its own text. The pruner's
`buildRequest` interpolates a chunk index only, so it is safe today — but that
is a property to assert in a test, not to assume.

## 6. Proposed layout

Keep g's workspaces shape. Split on product-vs-adapter, which is the axis it
already uses, not on harness, which would duplicate every product across two
trees and leave `replay` homeless.

```
packages/
  core/          tokens · jev wrapper · redact · shared types   ← §4 only
  audit/         setup audit domain (today's src/core, src/audit)
  prune/         today's packages/core, minus what moved to core/
  claude-code/   adapter: paths, hooks.json, inventory, CLI
  pi/            adapter
  replay/        eval harness
```

`packages/core` must stay free of both harnesses' imports, which is the rule
g already set for itself.

## 7. Sequencing

**Land Milestone 1 on `main` as-is, flat `src/` and all. Do the restructure as
its own change, after `g` merges.**

Restructuring before merging multiplies the conflict surface for no benefit:
the move is mechanical either way, and it is much easier to judge the real
overlap with both trees on `main` than to predict it from one side. It also
keeps a reviewed, tested, green branch from being reopened for churn that has
nothing to do with what it was reviewed for.

Order:

1. Merge `worktree-milestone-1-plan` → `main` (flat `src/`).
2. Merge `token-saver-g` → `main` (workspaces alongside `src/`, briefly ugly).
3. One restructure commit: create `packages/core` from §4, move both products
   in, delete the duplicate `estimateTokens`.
4. Only then, the pruner's redaction, which by step 3 is a matter of routing
   its state through the shared wrapper plus a test.

## 8. Left open

- **Which `estimateTokens` calibration the audit should use.** The audit
  currently hard-codes 4 chars/token. `calibrateCharsPerToken` needs samples
  the audit does not collect. Fine to keep the fallback, but it should be a
  decision rather than an accident.
- **Whether `replay` can evaluate the audit too.** It was built for pruning
  sessions. The audit's eval set is a different shape (projects, not
  sessions), and the design spec's §8 assumes one harness for both.
- **Feature C's owner.** The g spec defers output filtering to a `tool_result`
  handler in `packages/pi`. Claude Code has a `PostToolUse` hook that could do
  the same job, which would make C a third product rather than a pi feature.
