# token-saver: context-budget triggers — design

**Date:** 2026-09-23
**Status:** approved in brainstorming, pending spec review
**Amends:** `2026-09-17-token-saver-g-design.md` §6 (Triggers), §8 (Configuration), §9.2 (Replay)

## 1. Why

The primary goal of token-saver is keeping the context window small. Dollar savings are
secondary.

After the PR #1 review fixes, the dollar cost gate (§6.1 of the G spec) declines every sweep
on the representative replay sessions. It declines on GPT-6 Luna, Anthropic and Opus prices
alike, because their cache-read/cache-write ratios are the same (see
`docs/superpowers/notes/replay-baseline.md`). The user's main target is a local
Qwen3.8 27B Q4 model on llama.cpp with a 100k context window. It has no dollar cost at all.

On a local model the real cost of a sweep is **waiting**. Shortening a result invalidates
llama.cpp's KV cache from that point, so the whole suffix is prompt-processed again. Tokens
before the cut stay cached, so shortening does not save much prefill time on later calls.
What it buys is window headroom (later compaction), answer quality at shorter context, and
slightly faster decoding. So sweeps must be **rare, batched and well-timed**, not frequent
and marginal.

## 2. Triggers

| Trigger | Fires at | Condition | Target |
| --- | --- | --- | --- |
| `turn` (new) | The first model call after a user message | `usage >= highWater` and re-armed | Down to `lowWater` |
| `context` (existing, now emergency) | Any model call, including mid-run | `usage >= emergencyLevel` | Down to `lowWater` |

- `usage` is `ctx.getContextUsage()` tokens / context window.
- Both triggers pass through no dollar gate. The dollar cost gate (`planCostGate` as a
  go/no-go check) is removed as a trigger. Dollar figures remain in `/token-saver` stats and
  replay reports only. This also retires the DeepSeek pricing problem (`cacheWrite: 0`
  treated as "no caching").
- **Only sweep when the user sends a message.** Mid-run calls never sweep unless the
  emergency level is crossed. The user has just typed, so a pause there is expected. A
  mid-run pause makes the agent feel stuck.
- `emergencyLevel = min(contextLevel, (window - reserveTokens - 2000) / window)`, where
  `reserveTokens` is pi's compaction setting (`settings.compaction.reserveTokens`, default
  16384). pi compacts when `contextTokens > window - reserveTokens`
  (`compaction.js` `shouldCompact`). The emergency sweep must land before that point, or it
  would never run. For a 100k window with defaults: `min(0.85, 0.816) = 0.816`.
- On small windows the cap can fall below `highWater`. Example: 32k window gives
  (32768 - 16384 - 2000) / 32768 = 0.44. The turn trigger then uses
  `min(highWater, emergencyLevel)`, so it still fires at a user turn before the emergency
  trigger would fire mid-run.

### 2.1 Re-arming

After any sweep, let `reached` be the context size it produced (estimated tokens).

- If `reached <= lowWater * window`, the turn trigger is armed as normal. It fires again the
  next time usage crosses `highWater` at a user turn.
- Otherwise, the sweep could not reach the target: everything left was recent, protected,
  excluded, or Jev kept it. Then set `rearmAt = reached + (highWater - lowWater) * window`.
  The turn trigger stays disarmed until usage >= `rearmAt`. This stops a sweep, and its
  wait, from running on every message once the context settles above target.
- The emergency trigger ignores `rearmAt` but uses the same rule after it fires. Its
  `rearmAt` is capped at the compaction point: past that, pi's compaction takes over.
- A Jev failure or timeout counts as a sweep that reached whatever the free stubs reached.
  The same re-arm rule applies, so there is no retry loop.
- `rearmAt` is in-memory and resets on `session_start`. After a reload the first qualifying
  turn simply sweeps again.

## 3. Choosing what to shorten

The goal is to reach `lowWater` while prompt-processing as little as possible again. The
re-processed amount is the suffix after the **earliest** shortened result.

1. **Candidates** are unchanged: `selectEligible` (`minResultTokens`, `protectTurns`,
   `excludedTools`, not already decided or remembered as "leave"). For the emergency trigger
   `protectTurns` is 1, as today.
2. **Expected saving** per candidate: `tokens` if superseded (`findSuperseded`, with the
   stricter range and error rules), else `round(tokens * expectedSaveRatio)`.
3. **Cut point.** `need = currentTokens - lowWater * window`. Sort candidates by
   `messageIndex`. For `start` from the newest candidate back to the oldest, take
   `candidates[start..]` and sum the expected savings. Choose the **latest** `start` whose
   sum is >= `need`. If none reaches `need`, take all candidates. This reuses
   `planCostGate`'s "start from candidate i" loop with a new selection rule, as a new core
   function `planBudgetCut`.
4. **Judge** the chosen non-superseded candidates with Jev, as today. Superseded ones are
   stubbed without Jev. Results Jev leaves alone are remembered until the next user message
   (existing behavior).
5. **Apply** decisions and compute `reached`. Re-arm per §2.1.

A consequence: the newest large results are shortened first, reversing today's bias toward
the oldest. The re-processed suffix is then much shorter. `protectTurns` still shields the
most recent turns.

The existing `minSaving` check (post-Jev) still applies per result. The post-gate refusal
(§6.1 "post-gate") is dropped, because there is no cost gate left to refuse.

## 4. Configuration

| Key | Default | Change |
| --- | --- | --- |
| `highWater` | 0.75 | new: turn-trigger level (fraction of window) |
| `lowWater` | 0.30 | new: sweep target (fraction of window) |
| `contextLevel` | 0.85 | was 0.60; now the emergency level, capped below pi's compaction point |
| `costMargin` | — | removed (unused) |

Validation: `0 < lowWater < highWater < 1`, and `highWater <= contextLevel`. Invalid values
fall back to defaults with a warning, as other keys do.

If the context window is unknown (`getContextUsage()` missing, or no `contextWindow` on the
model), no sweep runs. `/token-saver` reports the reason.

`/token-saver` stats add: current usage (tokens and %), `highWater` / `lowWater` /
emergency levels in tokens, and `rearmAt` when disarmed.

## 5. Replay (§9.2 of the G spec)

The replay's main measure changes from dollars to context size.

- Simulate the `turn` trigger at the first call after each user message, and the `context`
  trigger at every call.
- Window size comes from the session's model where known. A `--window <tokens>` flag
  overrides it; `--reserve <tokens>` overrides pi's `reserveTokens` (default 16384).
- Report per tau:
  - peak context and mean context (tokens), before vs after
  - sweeps (total, and per session)
  - **tokens re-processed**: the sum of suffix tokens after each sweep's cut point, which
    stands for the waiting cost
  - **compactions avoided**: how many times the context would have crossed
    `window - reserve` without token-saver, versus with it
  - misses, Jev requests, and net $ (secondary)

A "compaction" in the replay is counted when simulated context crosses the compaction
point. The replay does not simulate what pi's summary would contain. After a counted
compaction, it continues with the recorded session as-is.

## 6. Components

- **core `policy/budget.ts`** (new): `planBudgetCut(candidates, need)` → ids, cut index,
  expected saving; `rearmAt(reached, window, levels)`; `emergencyLevel(window, reserve,
  contextLevel)`. Pure functions.
- **core `sweep.ts`**: `trigger: "turn" | "context"`. Replaces the `planCostGate` call with
  `planBudgetCut`; takes `currentTokens`, `window`, `levels`; returns `reached`.
  `planCostGate` stays exported for the report's dollar column.
- **pi `context.ts`**: tracks "first call since user message" and `rearmAt`; chooses the
  trigger; passes window and usage through.
- **pi `index.ts`**: reads `reserveTokens` from pi settings; stats output.
- **core `config.ts`**: new keys, removal, validation.
- **replay**: trigger simulation, `--window` / `--reserve`, new report columns.

## 7. Testing

- core: `planBudgetCut` picks the latest start that meets `need`; takes everything when
  nothing does; superseded candidates count at full size. `rearmAt` for reached-target and
  missed-target cases. `emergencyLevel` caps at the compaction point. Config validation.
- pi: the turn trigger fires only on the first call after a user message; mid-run calls
  don't sweep below the emergency level and do sweep above it; `rearmAt` suppresses
  repeated sweeps; a Jev failure applies stubs and re-arms; unknown window → no sweep.
- replay: a fixture that crosses 75% produces one turn sweep and the expected re-processed
  and compaction counts.
- The real check: replay over the user's local Qwen sessions with `--window 100000`,
  reporting peak context, sweeps per session and tokens re-processed.

## 8. Out of scope

- Measuring real prefill time. Tokens re-processed is the proxy. Wall-clock timing needs the
  live A/B (G spec §9.3).
- Claude Code adapter. Claude Code cannot prune history, so these triggers don't apply
  there.
- Changing Jev judgment, chunking or rendering.
