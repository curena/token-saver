# token-saver

Cuts an agent's token use by putting small TypeSafe Jev judgments in front of its decisions.

Two halves, built from opposite ends of the same design:

| | What it does | Runs | Harness |
|---|---|---|---|
| **Setup audit** (`packages/audit` + `packages/claude-code`) | Hides skills that do not fit the project, so they stop being injected | Between sessions, you invoke it | Claude Code |
| **Stale-result pruning** (`packages/prune` + `packages/pi`) | Elides large, old tool results the agent has finished with | Mid-session, before each model call | pi |

Both need a TypeSafe API key, and both fail open without one: no key means no
judgment, and no judgment means no change.

```bash
export TYPESAFE_API_KEY=...
```

The audit also reads a `.env` file at the project root (via Node's own loader, no
dependency). A variable already set in your shell wins over the file — so
`TYPESAFE_API_KEY= token-saver audit` still exercises the no-key path even with a key
on disk. `.env` is gitignored and on the redaction denylist below.

Both sit in one npm workspace. `packages/core` holds the surface they share — the
token estimator, the redaction pass, and the Jev client wrapper — and imports neither
harness.

---

## The setup audit (Claude Code)

```bash
npm install
npm run build -w @token-saver/claude-code
npm link packages/claude-code
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

Add the `SessionStart` hook from `packages/claude-code/src/hooks.json` to your settings
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

Everything either product sends to Jev goes through one pass in `packages/core` first —
the audit's project data (README, manifests, file tree, recent prompts) and the pruner's
tool-result text (file contents, command output) alike. Both reach Jev through the same
wrapper, so redaction happens by construction rather than by each side remembering to do
it.

Two layers:

**A path on the denylist is skipped entirely** — not redacted, not sent:

- `.env*` (including `.envrc`)
- `*.pem`
- `id_*`
- `secrets/**`

The audit never opens such a file. The pruner never opens anything, so it does the
equivalent: a tool result whose input names a denylisted path is left alone — unjudged,
unsent, and unpruned. You lose the saving on that one result and the content never leaves
the machine.

**Everything else is scanned** for high-entropy strings — provider key prefixes, JWTs,
`SOMETHING_TOKEN=…` assignments, and unrecognised random-looking runs — and each match is
replaced with `[REDACTED]` before the request goes out.

The masked copy exists only for the duration of the Jev call. Every line you or the agent
sees — a rendered stub, a `recall`ed range, the audit's table — comes from the original
text, so redaction never changes what the agent is working with. That also means the
scanner is tuned for recall over precision: an over-eager mask costs Jev a little context
and nothing else.

Known limits, stated rather than implied: the denylist matches paths, so a secret typed
straight into a command (`export API_KEY=…`) is caught by the content scan or not at all,
and the scan is a heuristic. Precision gets measured against the eval harness in
Milestone 2.

## Development

```bash
npm test            # every package's suite
npm run typecheck   # tsc -b across all six projects
npm run build       # the Claude Code CLI and the pi extension
```

Six packages, split on product-vs-adapter rather than on harness:

| Package | Holds |
|---|---|
| `core` | `tokens` · `redact` · the Jev wrapper — no harness, no product |
| `audit` | setup-audit domain: fit policy, profile, proposals, apply/undo |
| `prune` | pruning domain: chunking, sweeping, staleness, budget |
| `claude-code` | adapter: skill inventory, transcript usage, paths, the CLI |
| `pi` | adapter: pi extension, context hooks, `recall` |
| `replay` | eval harness over recorded sessions |

Design docs:

- [Overall design](docs/superpowers/specs/2026-09-17-token-saver-design.md)
- [Stale-result pruning (feature G)](docs/superpowers/specs/2026-09-17-token-saver-g-design.md)
- [Context budget](docs/superpowers/specs/2026-09-23-token-saver-context-budget-design.md)
- [Reconciling the two branches](docs/superpowers/specs/2026-09-27-two-product-reconciliation.md)
