# Milestone 1 — live smoke test (Task 10)

Run 2026-09-27 on `worktree-milestone-1-plan` @ `687364e`, Claude Code 2.1.283,
Node 24.19.0, `@typesafe-ai/sdk` 0.6.0, Jev model `jev-1.13.0`.

## Result

Milestone 1 works end to end against the real filesystem and the live Jev API.
Two defects found, both in proposal policy, neither a blocker for the milestone.

## Step 1 — no-key path

```
TYPESAFE_API_KEY= node dist/cli.js audit
→ No changes proposed.   exit 0
```

Also confirms live that a shell-set empty variable beats a real key in `.env`
(the documented precedence), because `.env` held a valid key at the time.

## Step 2 — live audit

| Measure | Value |
|---|---|
| Skills found | 15 managed (of 53 total; the rest are plugin-sourced and not settable) |
| Jev requests | **1 per audit** — all 15 questions go in one `systemOne` call |
| Duration | 0.39s warm cache, 0.44s cold cache |
| Degraded judgments | 0 |
| Estimated saving | 2,478 tokens/session |

Cold-cache rerun produced slightly different scores (`built-in-browser`
2.69 → 2.67), confirming a real network call rather than a cache replay.

Raw fit scores (0 = regularly needed … 3 = unrelated; threshold at 2.5):

| skill | score | conf | → |
|---|---|---|---|
| skill-creator | 0.84 | 0.16 | name-only |
| docs | 1.78 | 0.36 | name-only |
| deep-research | 2.41 | 0.41 | name-only |
| computer-use | 2.42 | 0.42 | name-only |
| import-memory | 2.52 | 0.52 | user-invocable-only |
| built-in-browser | 2.67 | 0.67 | user-invocable-only |
| theme-factory | 2.73 | 0.73 | user-invocable-only |
| chrome-browser | 2.76 | 0.76 | user-invocable-only |
| morning | 2.81 | 0.81 | user-invocable-only |
| web-artifacts-builder | 2.85 | 0.85 | user-invocable-only |
| pdf | 2.86 | 0.86 | user-invocable-only |
| pptx | 2.87 | 0.87 | user-invocable-only |
| docx | 2.89 | 0.89 | user-invocable-only |
| xlsx | 2.90 | 0.90 | user-invocable-only |
| hf-cli | 2.91 | 0.91 | user-invocable-only |

`uses` was 0 for all 15, and that is correct rather than a detection gap: the
only skills ever invoked in this project's transcripts are `superpowers:*` and
`typesafe:typesafe-ai`, which are plugin-sourced and therefore unmanaged.

## Step 3 — disagreements

**`skill-creator` (0.84, the single most relevant score) is still demoted.**
Jev is right that a skills-tooling project would reach for it; the 30-day
unused rule demotes it anyway. Policy working as written, but it is the one row
where judgment and proposal point opposite ways. Cost of being wrong: 84 tokens.

**Confidence is low exactly where it matters.** `computer-use` (0.42),
`deep-research` (0.41) and `import-memory` (0.52) sit within 0.1 of the
threshold. All three landed on the gentler change, which is the right way to be
wrong.

**Profile richness moves the verdict.** Re-running against a scratch root
holding only `README.md` and `package.json` shifted every score toward
irrelevant, and flipped the two borderline skills across the threshold:

| skill | full project | README+package only | Δ |
|---|---|---|---|
| skill-creator | 0.84 | 1.95 | **+1.11** |
| docs | 1.78 | 2.18 | +0.40 |
| import-memory | 2.52 | 2.71 | +0.19 |
| computer-use | 2.42 | **2.57** | +0.15 ← flips |
| deep-research | 2.41 | **2.51** | +0.10 ← flips |
| others | — | — | −0.04 … +0.08 |

Without the `src/` tree nothing signals this is a skills project, which is why
`skill-creator` moves most. Worth knowing for the eval harness: the profile
builder's coverage is load-bearing on borderline skills, not just cosmetic.

## Steps 4–5 — apply / undo round trip

Ran against a scratch root: Claude Code's auto-mode classifier refuses to let an
agent write `.claude/settings.local.json` (self-modification), so the live-path
write is a manual step for the user. Same code path, same proposals.

**Over a file that did not exist:** apply created it; undo left
`{"skillOverrides": {}}` behind rather than deleting the file. Semantically a
no-op, not byte-for-byte.

**Over a file with pre-existing content** (`permissions.allow`, plus
`pdf: name-only` and `morning: off`): `permissions` preserved, key order
preserved, and undo restored every value including `morning: "off"`. The only
diff against the pre-apply bytes was JSON re-formatting — an inline
`["Bash(ls:*)"]` came back expanded across three lines, because apply rewrites
the whole file with `JSON.stringify(x, null, 2)`.

So: **undo is a faithful semantic inverse, but not a byte-for-byte one.**

## Defects found — both fixed in `1d75a60`

### D1 — apply silently reverses a user's explicit `off`

`proposeState` (`src/core/policy.ts:12-39`) never consults `item.currentState`
except as the `from` field and as a fallback. The guard it does have — "never
propose `off`" — protects access but does nothing to protect a user's own
decision to disable a skill. In the round-trip test, `morning: "off"` was
rewritten to `"user-invocable-only"`, re-enabling a skill the user had turned
off. The `uses > 0` branch is the same bug with more reach: it proposes plain
`on`, restoring automatic injection for a skill the user had restricted.

Undo recovers it, but only for a user who notices.

Fix shape: treat `currentState === "off"` as sticky, and more generally never
propose a state strictly more visible than the current one unless `uses > 0`.

### D2 — the savings estimate ignores existing overrides

`tokens: item.tokens` in the same function is the skill's full cost, regardless
of how restricted it already is. The scratch run reported the same 2,478 tokens
with `pdf` already at `name-only` and `morning` already `off` as it did with no
overrides at all. The estimate should be the delta between the current state's
cost and the proposed state's cost.

## Re-verification after the fix

Same scratch root, same pre-existing `pdf: name-only` / `morning: off`, rebuilt
CLI:

- `morning` no longer appears in the table at all — clamped `off` → `off`, so
  there is no change to propose. Apply touched 14 keys, not 15, and left
  `"morning": "off"` intact.
- `pdf` reports `name-only -> user-invocable-only` saving **1 token**, not the
  111 it previously claimed.
- Headline moved from 2,478 to **2,275 tokens** — the difference is the two
  items that were already restricted, plus the name that `name-only` leaves
  behind for `docs` (247 → 246) and `skill-creator` (84 → 80).
- Undo restored both prior overrides exactly; the only diff against the
  pre-apply bytes is still the JSON array re-formatting.

178 tests pass (was 168), `tsc --noEmit` clean.

## Carry-forwards

- A 401 currently renders as "errors or timeouts". An auth failure is permanent
  and actionable; a timeout may be transient. Fail-open flattens them together.
- Writing `.claude/settings.local.json` is agent-blocked, so `--apply` is
  inherently user-run. The README should say so.
