# Dogfooding token-saver

How to run the extension against your own sessions and read the results.
Complements `replay-baseline.md` (offline tuning) with the live-session path.

## Prerequisites

- Built extension: `npm install && npm run build -w @token-saver/pi` → `packages/pi/dist/token-saver.js`
- TypeSafe key: `export TYPESAFE_API_KEY=...` (never commit it). Without the key the
  extension loads but stays inert and warns once at session start.

## Load it

In a session:

```bash
pi --extension "$(pwd)/packages/pi/dist/token-saver.js"
```

Or permanent, in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/home/archie/workspace/token-saver/packages/pi/dist/token-saver.js"] }
```

## Step 1 — Offline: replay your own history first

Measure against sessions already recorded before trusting a live run:

```bash
export TYPESAFE_API_KEY=...
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions --tau 0.1,0.2,0.3,0.5 --report out/
```

Output: `out/report.md` + `out/metrics.json` (tokens saved, misses, cost-gate spend).
Jev answers cache to `out/jev-cache.json`, so re-runs are free.

## Step 2 — Live session

Start pi with the flag, then:

1. Ask the agent to read a large file (result above `minResultTokens: 1500`).
2. Keep working 3+ turns so that result leaves the `protectTurns: 2` window.
3. `/token-saver` — expect `stubbed >= 1` and `tokens freed` growing.
4. Prove recovery: ask a follow-up that needs an elided detail and confirm the
   agent calls `recall` (id from the `[token-saver]` marker) instead of re-reading.
5. A/B: `/token-saver off` on a comparable run; compare context growth vs. on.

## Commands

| Command | What |
|---|---|
| `/token-saver` | stats: stubbed, partial, ~tokens freed, recalls, Jev $ spend |
| `/token-saver off` | pause sweeps (stubs already in context stay) |
| `/token-saver on` | resume |
| `/token-saver restore <id>` | drop one decision; that result returns in full once |
| `recall` tool | model restores elided text on demand |

## Known unknowns — to fill in live

- **Price-unit probe (unresolved).** The cost gate reads `ctx.model.cost` and guesses
  the unit (`input > 0.001` ⇒ divide by 1e6). Never confirmed against a real model.
  If `/token-saver` shows `0 stubbed` while feeding it clearly-large results, check
  that `ctx.model.cost.cacheWrite` is nonzero and the heuristic picked the right unit.

## Tuning knobs

Config precedence: `~/.pi/token-saver.json` → `.pi/token-saver.json` (cwd) →
`TOKEN_SAVER_*` env vars. Key knobs:

- `minResultTokens` (1500) — lower if your tool results are smaller.
- `keepThreshold` / τ (0.3) — tune via the replay `--tau` sweep.
- `excludedTools` (`["edit","write"]`) — results from these are never stubbed.
- `TOKEN_SAVER=off` disables entirely.