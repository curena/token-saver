# token-saver

token-saver is a [pi](https://github.com/earendil/pi-coding-agent) extension that prunes stale tool results out of model context. Before each model call it sends large, old tool results to TypeSafe's Jev model, which marks each chunk keep or elide, so the agent stops paying to re-send text it has already used. A `recall` tool restores any elided text on demand, and a replay harness measures savings and misses against recorded sessions.

## Install

```bash
npm install
npm run build -w @token-saver/pi
```

Then load the extension by passing `--extension "$(pwd)/packages/pi/dist/token-saver.js"` to pi, or by adding that path to pi's `extensions` setting.

## Configuration

Judgment runs through TypeSafe's Jev model, so the extension needs a TypeSafe API key:

```bash
export TYPESAFE_API_KEY=...
```

With no key the extension still loads but stays inert (it says so once at session start).

Settings are read from `~/.pi/token-saver.json`, then `.pi/token-saver.json` in the project, then `TOKEN_SAVER_*` environment variables. `TOKEN_SAVER=off` disables the extension entirely.

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

## Commands

- `/token-saver` — show stats (stubbed, partial, tokens freed, recalls, Jev spend)
- `/token-saver off` — disable sweeping for this session
- `/token-saver on` — re-enable sweeping for this session
- `/token-saver restore <id>` — drop a stored decision so its result is returned in full once

When a result is elided, the agent can call the `recall` tool with the id shown in the `[token-saver]` marker (plus optional `startLine`/`endLine`) to get the full text back rather than guessing or re-running the command.

## Replay harness

Measure savings and misses against recorded pi sessions without a live session:

```bash
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions --tau 0.1,0.3 --report out/
```

`<sessions...>` may be a directory (walked for `.jsonl`) or individual files. The run writes `out/report.md` and `out/metrics.json`, caching Jev answers in `out/jev-cache.json` so re-runs are free. Real sessions need `TYPESAFE_API_KEY`; the test fixture runs offline because its results sit below the sweep floor:

```bash
npx tsx packages/replay/src/cli.ts packages/replay/test/fixtures/session.jsonl --tau 0.1,0.3 --report out/
```

## How it works

At each model call the extension operates on pi's rebuilt context, finds large tool results outside the protection window, and asks Jev to score each chunk of each one. A cost check decides per result whether to keep it, stub it, or keep only the still-relevant chunks; decisions are cached and immutable, and everything fails open (no key, no prices, or no budget means leave the context alone). The sweep decision is recorded as a display-only transcript entry, while the original text stays in the session file and is recovered through `recall`. Full detail, including the retained-chunk Jev model and the cost gate, is in [`docs/superpowers/specs/2026-09-17-token-saver-g-design.md`](docs/superpowers/specs/2026-09-17-token-saver-g-design.md).
