# token-saver

Cuts an agent's token use by putting small TypeSafe Jev judgments in front of its decisions.

Two halves, built from opposite ends of the same design:

| | What it does | Runs | Harness |
|---|---|---|---|
| **Setup audit** (`src/`) | Hides skills that do not fit the project, so they stop being injected | Between sessions, you invoke it | Claude Code |
| **Stale-result pruning** (`packages/`) | Elides large, old tool results the agent has finished with | Mid-session, before each model call | pi |

Both need a TypeSafe API key, and both fail open without one: no key means no
judgment, and no judgment means no change.

```bash
export TYPESAFE_API_KEY=...
```

The audit also reads a `.env` file at the project root (via Node's own loader, no
dependency). A variable already set in your shell wins over the file — so
`TYPESAFE_API_KEY= token-saver audit` still exercises the no-key path even with a key
on disk. `.env` is gitignored and on the redaction denylist below.

> The two halves still have two project shapes — a flat `src/` and an npm workspace
> under `packages/` — because they were merged before being restructured. See
> [the reconciliation note](docs/superpowers/specs/2026-09-27-two-product-reconciliation.md)
> for the shared surface they will collapse onto.

---

## The setup audit (Claude Code)

```bash
npm install && npm run build && npm link
```

```bash
token-saver audit            # show proposed skill visibility changes
token-saver audit --apply    # write them to .claude/settings.local.json
token-saver audit --undo     # revert the last applied change
```

It inventories your skills, judges each one's fit against the project in a single Jev
request, and proposes `skillOverrides`. Two guarantees about what it will not do:

- It never proposes `off`, so every skill stays reachable as `/name`.
- It never raises a skill's visibility above where you already set it. If you turned
  something off, it stays off.

`--apply` is yours to run: Claude Code blocks an agent from writing
`.claude/settings.local.json`, so an agent cannot apply the audit on your behalf.

Add the `SessionStart` hook from `src/adapters/claude-code/hooks.json` to your settings
to be reminded when your skills or project drift enough to warrant a fresh audit. The
hook only reminds — it changes nothing by itself.

## Stale-result pruning (pi)

```bash
npm install
npm run build -w @token-saver/pi
```

Load the extension by passing `--extension "$(pwd)/packages/pi/dist/token-saver.js"` to
pi, or by adding that path to pi's `extensions` setting.

Before each model call it sends large, old tool results to Jev, which marks each chunk
keep or elide, so the agent stops paying to re-send text it has already used. The
original text stays in the session file; a `recall` tool restores any elided range on
demand, using the id shown in the `[token-saver]` marker.

Settings are read from `~/.pi/token-saver.json`, then `.pi/token-saver.json` in the
project, then `TOKEN_SAVER_*` environment variables. `TOKEN_SAVER=off` disables the
extension entirely.

| Setting | Default | Meaning |
|---|---|---|
| `minResultTokens` | 1500 | Smaller results are never touched |
| `protectTurns` (K) | 2 | Results from the last K user turns are never touched |
| `keepThreshold` (τ) | 0.3 | Chunks at or above this are kept verbatim |
| `leaveAloneRatio` | 0.7 | Keeping this share of tokens means leaving the result alone |
| `minSaving` | 500 | Below this saving, make no change |
| `contextLevel` | 0.85 | Emergency sweep level (capped just below pi's compaction point) |
| `highWater` | 0.75 | Sweep at your next message once context passes this fraction of the window |
| `lowWater` | 0.30 | Sweep target, as a fraction of the window |
| `expectedSaveRatio` (r) | 0.5 | Assumed saving before Jev answers |
| `jevBudgetMs` | 1500 | Over budget, abandon the sweep |
| `jevModel` | `jev-1.13.0` | Pinned; thresholds are tuned per model version |

Commands:

- `/token-saver` — show stats (stubbed, partial, tokens freed, recalls, Jev spend)
- `/token-saver off` / `/token-saver on` — disable or re-enable sweeping this session
- `/token-saver restore <id>` — drop a stored decision so its result returns in full once

### Replay harness

Measure savings and misses against recorded pi sessions without a live session:

```bash
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions --tau 0.1,0.3 --report out/
```

`<sessions...>` may be a directory (walked for `.jsonl`) or individual files. The run
writes `out/report.md` and `out/metrics.json`, caching Jev answers in
`out/jev-cache.json` so re-runs are free. Context size at each call is the session's
recorded provider usage (input + cache read + cache write), or a chars/4 estimate where
a call recorded none. Real sessions need `TYPESAFE_API_KEY`; the test fixture runs
offline because its results sit below the sweep floor:

```bash
npx tsx packages/replay/src/cli.ts packages/replay/test/fixtures/session.jsonl --tau 0.1,0.3 --report out/
```

Extra flags:

- `--window <tokens>` — context window for every session; otherwise looked up from
  `~/.pi/agent/models-store.json`
- `--reserve <tokens>` — pi's `compaction.reserveTokens` (default 16384)
- `--models <path>` — path to the models-store.json used for the `--window` lookup

## Redaction

Before any project data (README, manifests, file tree, recent prompts) is sent to Jev,
it is run through a redaction pass. A path matching the denylist is never read for this
purpose at all:

- `.env*`
- `*.pem`
- `id_*`
- `secrets/**`

Everything else is scanned for high-entropy strings (API keys, tokens) and redacted in
place before it leaves your machine.

**This covers the audit, not yet the pruner.** The pruner sends the text of tool
results — file contents, command output — which is the half the requirement was written
for. Closing that gap is tracked in
[the reconciliation note](docs/superpowers/specs/2026-09-27-two-product-reconciliation.md), §5.

## Development

```bash
npm test        # both suites: tests/ and packages/*/test/
npm run typecheck
```

Design docs:

- [Overall design](docs/superpowers/specs/2026-09-17-token-saver-design.md)
- [Stale-result pruning (feature G)](docs/superpowers/specs/2026-09-17-token-saver-g-design.md)
- [Context budget](docs/superpowers/specs/2026-09-23-token-saver-context-budget-design.md)
- [Reconciling the two branches](docs/superpowers/specs/2026-09-27-two-product-reconciliation.md)
