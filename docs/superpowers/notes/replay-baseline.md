# Replay baseline

**Status: context-budget run (2026-09-25) — see "Context-budget run (2026-09-25)" below for
the current numbers against the turn/emergency triggers. The 2026-09-23 re-run and 2026-09-18
numbers are kept for history: they measured the old dollar cost gate, since replaced by the
context-budget triggers.**

## The first run was contaminated — discarded

The first run over `~/.pi/agent/sessions` reported up to 28.7% saved, but it measured
token-saver's own development:

- All 13 sweeps (and ~all 226/199/250 misses) came from 12 forks of
  `--home-archie-workspace-token-saver--` plus 1 hoard fork. The other ~24 session
  files (141 calls) never swept at all.
- `cli.ts` re-read every file per tau, so the live token-saver session — which grew by
  +522,225 result-tokens mid-run — made the τ=0.1 totals internally inconsistent
  (126.2M vs 126.8M "before").

Fixed in `cc0b115`+next: `readSessionFiles()` (`packages/replay/src/files.ts`) snapshots
each file once before the tau loop, with a regression test. See
`packages/replay/src/cli.ts`.

## Clean re-run (out/representative)

Six static session dirs, live session excluded: `--home-archie-workspace-hoard--`,
`--home-archie--`, `--data-llama.cpp-adaptive-kv-streaming--`,
`--data-tools-ASCII-Condensed-prune-tools--`, `--tmp-tmp.o1bhmBmKQB-repo--`,
`--home-archie-workspace-test--`. 37 files, identical across all tau (no drift).

| tau | saved | misses | net $ | jev $ |
| --- | --- | --- | --- | --- |
| 0.1 | 0.0% | 0 | -0.0118 | 0.0118 |
| 0.2 | 1.5% | 2 | -0.0527 | 0.0018 |
| 0.3 | 2.6% | 6 | -0.0874 | 0.0018 |
| 0.5 | 2.8% | 8 | -0.0837 | 0.0018 |

All activity is 1 hoard file (2-6 stubbed). The other 36 files — home, llama.cpp,
etc. — never swept once.

## What the numbers actually say

- **Real-world savings are 0-2.8%, not 28.7%.** The extension rarely fires on ordinary
  sessions (results below the 1500-token floor or declined by the cost gate), and when
  it does fire the total saving is single-digit percent.
- **No τ wins on misses.** 0-8 misses, but they rise with τ while savings stay tiny, so
  the "largest τ with zero misses" rule has no answer worth selecting.
- **net-$ is negative at every τ** under the replay's hardcoded Anthropic prices
  (input 3e-6, cacheRead 0.3e-6, cacheWrite 3.75e-6). The reason is structural: the spec
  §6.1 cost model bills the whole `T_after` suffix at the expensive `cacheWrite` rate on
  each sweep, while the savings are billed at the cheap `cacheRead` rate. With prompt
  caching already giving ~90% off re-reads, stubbing saves little in dollars.
- The replay measures **only dollar cost**. It does not measure the context-window value
  (fewer compactions, longer useful history) — likely the real reason to use token-saver.

## To fill in before this is actionable

- **Actual model prices.** The replay hardcodes Anthropic cache prices; the user's model
  (deepseek via openrouter) has different cache economics. The live extension already
  reads `ctx.model.cost` (`priceOf` in `packages/pi/src/index.ts`) — use those numbers to
  re-judge net-$ rather than the replay defaults.
- **Context-window metric.** Compare compaction frequency / `getContextUsage()` tokens with
  `/token-saver on` vs `off` over the same task — the dollar number may never show the win.

## Re-run after review fixes (out/representative-v2, 2026-09-23)

Same six session dirs and taus as the clean re-run, after the PR #1 review fixes (suffix
now counts assistant `toolCall` arguments, call sites exclude their own output, misses
count only from the sweep point, reads only supersede covered ranges).

| tau | saved | misses | net $ | jev $ |
| --- | --- | --- | --- | --- |
| 0.1 | 0.0% | 0 | 0.0000 | 0.0000 |
| 0.2 | 0.0% | 0 | 0.0000 | 0.0000 |
| 0.3 | 0.0% | 0 | 0.0000 | 0.0000 |
| 0.5 | 0.0% | 0 | 0.0000 | 0.0000 |

Same 6,307,221 tokens before; zero sweeps and zero Jev requests at every tau. The cost
gate now declines every candidate.

**Cause, isolated by swapping files into the old code** (hoard sessions, the only ones
that ever swept):

- Old code: 7 call sites passed the cost gate.
- New code: 0 pass. Best gated value/cost is ~1.11 against the required `costMargin` 1.5
  (it was ~1.44 among the old gated sites).
- New staleness rules alone: no change (still 7).
- New `session.ts` with the `toolCall`-argument counting disabled: back to 7.

So counting tool-call arguments in the suffix is the whole difference. The old sweeps
passed only because the rewrite cost was underestimated. This matches the old negative
net-$: at Anthropic cache prices those sweeps never paid for themselves.

This strengthens the conclusion above: the open question is the pricing model (the
user's real model prices via `ctx.model.cost`) and the context-window metric, not τ.

**Keep-threshold decision: leave `keepThreshold` at the spec default 0.3.** This data
does not justify a change; the open question is the pricing model, not τ.

## Context-budget run (2026-09-25)

After Tasks 1-5 replaced the dollar cost gate with the turn/emergency context-budget
triggers (`highWater` 0.75, `contextLevel` 0.85, `lowWater` 0.30), the replay harness now
reports context size directly (peak/mean tokens, sweeps, re-processed tokens, compactions)
instead of a cost gate pass/fail. This run measures the local Qwen (llama.cpp) sessions
against those triggers.

```bash
mkdir -p out/qwen-budget && cp out/representative-v2/jev-cache.json out/qwen-budget/
S=~/.pi/agent/sessions
npx tsx packages/replay/src/cli.ts "$S/--home-archie--" "$S/--data-llama.cpp-adaptive-kv-streaming--" \
  "$S/--data-tools-ASCII-Condensed-prune-tools--" "$S/--home-archie-workspace-test--" "$S/--tmp-tmp.o1bhmBmKQB-repo--" \
  --window 100000 --tau 0.3 --report out/qwen-budget
```

24 session files (`--home-archie--` 15, `--data-llama.cpp-adaptive-kv-streaming--` 6,
`--data-tools-ASCII-Condensed-prune-tools--` 1, `--home-archie-workspace-test--` 1,
`--tmp-tmp.o1bhmBmKQB-repo--` 1), forced to a 100,000-token window with `--window` since
these are local llama.cpp sessions with no entry in `models-store.json`.

| tau | peak ctx before | peak ctx after | mean ctx before | mean ctx after | sweeps | re-processed | compactions before | compactions after | misses | jev reqs | jev $ | net $ | tokens before | tokens after | saved | stubbed | partial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.3 | 12,653 | 12,653 | 3,873 | 3,873 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 0.0000 | 297,639 | 297,639 | 0.0% | 0 | 0 |

The DeepSeek/hoard run (`--home-archie-workspace-hoard--`, window looked up from
`models-store.json` rather than forced) is pending the user's go-ahead, since it makes paid
Jev calls:

```bash
mkdir -p out/deepseek-budget && cp out/representative-v2/jev-cache.json out/deepseek-budget/
npx tsx packages/replay/src/cli.ts "$S/--home-archie-workspace-hoard--" --tau 0.3 --report out/deepseek-budget
```

What the numbers say:

- **No reduction at all on the Qwen sessions: peak and mean context are identical before and
  after (12,653 / 3,873 tokens).** The triggers never fired, so there was nothing to reduce.
- **Zero sweeps, zero re-processed tokens, across all 24 session files.** There is no
  per-sweep re-processing cost to report here because no sweep ever ran.
- **Zero compactions before and after — none avoided, because none ever happened.** These
  sessions never grew large enough to need pi's compaction in the first place, so this run
  can't show whether token-saver prevents it.
- **Zero misses**, consistent with zero sweeps — there is nothing elided that could be missed.
- **Token-saver's context-budget triggers barely matter on these sessions, and that's the
  honest finding.** The peak context reached across all 24 files was 12,653 of a 100,000-token
  window (12.7%) — 0 of 24 sessions ever passed `highWater` (75,000 tokens, 75%), let alone the
  emergency level (~81,616 tokens, 81.6%, from `contextLevel` 0.85 capped by `reserveTokens`
  16,384 and the 2,000-token compaction margin). Local Qwen sessions with a 100k window simply
  never fill it; this replay says nothing yet about whether the triggers help on the user's
  real (DeepSeek/hoard) sessions, which is what the pending run above should show.