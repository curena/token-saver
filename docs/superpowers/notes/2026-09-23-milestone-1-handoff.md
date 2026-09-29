# Milestone 1 — handoff

Branch: `worktree-milestone-1-plan`. Plan: `docs/superpowers/plans/2026-09-17-milestone-1-core-and-audit.md`.
Spec: `docs/superpowers/specs/2026-09-17-token-saver-design.md`.

Tasks 1–9 and 11 are complete. **Task 10 (live smoke test) was deliberately not run** — it needs a
real `TYPESAFE_API_KEY`, it sends this project's README / manifests / file tree / recent prompts to
the TypeSafe API, and step 3 requires the user's own judgment about their own skills. It is the last
thing standing between this branch and "exercised end to end against the real API."

The SDD ledger is scratch and was deleted with its workspace. This note is the durable record of the
decisions made while executing the plan.

---

## Task 10 — for you to run

Build first: `npm run build`.

```bash
# 1. No key — must print "No changes proposed." and exit 0, never throw.
TYPESAFE_API_KEY= node dist/cli.js audit

# 2. With your key — prints the table. Writes nothing.
node dist/cli.js audit

# 3. Read every row by hand. For each proposed `user-invocable-only`, confirm you agree the
#    skill is irrelevant to this project. Confirm any skill you have used recently is absent
#    from the table. Disagreements are the input to Milestone 2's thresholds — record them
#    even when they seem minor.

# 4. Apply, inspect, undo, inspect.
node dist/cli.js audit --apply
cat .claude/settings.local.json
node dist/cli.js audit --undo
cat .claude/settings.local.json
```

Then write `docs/superpowers/notes/2026-09-17-milestone-1-smoke.md` recording: skills found,
estimated tokens saved, audit duration, number of Jev requests, any proposal you disagreed with,
and whether the undo restored the file exactly.

**Expectation to set before you run it:** `claudePaths` returns no plugin skill dirs, so the audit
covers personal/project skills only. On this machine most of the skill roster is plugin skills
(`superpowers:*`, `anthropic-skills:*`, …), so the reported saving will be much smaller than the
spec's framing implies. That scoping was deliberate and is noted in the plan's self-review.

---

## Rulings made during execution

Each is `<decision> — <why> — <cost if wrong>`.

### Pre-flight (scanning the plan before Task 1)

1. **`src/core/` may import `score` from `@typesafe-ai/sdk`.** The Global Constraint's intent is no
   I/O in core — no network, no fs, no clock — and `score()` is a pure question-shape constructor.
   *Cost if wrong:* core is not unit-testable without the SDK installed.
2. **Task 3's tests may cast into `score()`'s return shape.** Asserting `.instructions` and
   `.criteria` is the only way to check question content without a live API. *Cost if wrong:* the
   casts break when the SDK changes shape, and the tests need updating.
3. **The plan's expected test counts are advisory.** Task 8's brief says "PASS (10 tests)" for a file
   with 11. The binding expectation is that every test passes. *Cost if wrong:* none.
4. **`writeSettings` gets `mkdirSync(dirname(path), {recursive:true})` now**, not deferred to the
   smoke test as Task 9's text suggested. *Cost if wrong:* one unnecessary syscall per write.

### Per-task

5. **Task 1 — the `looksRandom` entropy heuristic ships as specified.** Tuning waits for Milestone 2,
   when the smoke test provides real false-positive data. *Cost if wrong:* over-masking costs a
   little judgment context; under-masking is the real risk and is bounded by the denylist.
6. **Task 2 — the behavior stays, but the wart becomes visible:** a fix round added a test pinning it
   rather than silently changing it. *Cost if wrong:* none; the test documents intent.
7. **Task 3 — accept the SDK deviation.** `ScoreCriteria` is an ordered tuple and `ScoreResponse.score`
   is a number, not a level name; the brief's prose predates that verified shape. *Cost if wrong:*
   none — the SDK's type system does not permit the alternative.
8. **Task 4 — `maxRetries: 0` deferred to Task 9's `makeJev`** via dependency injection rather than
   hardcoded in the wrapper. *Since satisfied.*
9. **Task 5a — the Global Constraint overrides the brief's sample code** where they disagree on
   crash-on-malformed-state. *Cost if wrong:* a caller sees `{}` where it expected a throw.
10. **Task 5b — `appendAudit` rejects a non-string `previous` loudly**, naming the offending key,
    rather than coercing. *Cost if wrong:* a write fails fast instead of recording an unrestorable value.
11. **Task 7a — the denylist applies to the file tree's *enumeration*, not only to reads.** A
    denylisted path must not appear in the tree at all. *Cost if wrong:* none; strictly more conservative.
12. **Task 7b — take a fix round for all three Minors.** The privacy boundary is the one constraint
    stated verbatim by the user, and all three were single-line edits. *Cost if wrong:* one extra round.
13. **Task 7c — widening `redact.ts`'s DENYLIST is not a Task-1 pin violation.** The pin covers the
    entropy heuristic; the denylist is separate, additive and strictly more conservative. *Cost if
    wrong:* a repo with a legitimate top-level `secrets/` dir loses that one tree entry.
14. **Task 8 — accept a numeric `judgeFit` mock.** The brief's mock used a string `score`, which
    `parseFit` silently discards, so the test asserted 25 fits while producing 0 and could never fail.
    *Cost if wrong:* none.
15. **Task 9a — accept `retry: { maxRetries: 0 }`.** The installed SDK has no top-level `maxRetries`.
    Binding intent is "no SDK retries behind our timer," verified against both the constructed client
    and a live ~10.037s timing test against a hang-forever server. *Cost if wrong:* retries inside the
    10s budget would eat the deadline.
16. **Task 9b — the degraded-audit signal goes in the output, not the exit status.** Exit stays 0
    because failing open means not breaking the user's workflow. *Cost if wrong:* a script that wants
    to detect degradation must parse stderr.
17. **Task 9c — the `.env*` mismatch is a code bug, not a doc bug.** `.env*` is the user's verbatim
    wording and `.envrc` routinely holds exported keys, so the regex was widened rather than the
    README narrowed. *Cost if wrong:* a file like `.envelope.md` is dropped from the tree — invisible
    and harmless.
18. **Task 11 — accepted without a review dispatch.** A single note, read in full, separating observed
    from inferred exactly as briefed. *Cost if wrong:* a spike note carries an unchallenged claim; it
    is explicitly labelled unresolved.

### Final whole-branch review

19. **Fix wave scope** = C1, C2, C3, I1–I6, the `fitQuestions` redaction gap, the SDK timeout race,
    and three named test repairs. Each is either a silent-wrong-output bug on this machine, a
    settings-restore defect, or a ≤5-line change on a path proven untested. *Cost if wrong:* one more
    fix round on an unmerged branch.
20. **Park to Milestone 2:** a settings lockfile (I7), unifying the two `skillOverrides` readers (I8),
    and all Minors. I7 is low-likelihood and needs a lockfile design of its own; I8 is a refactor with
    no current defect. *Cost if wrong:* a concurrent `--apply`/`--undo` race corrupts one settings
    file; the user re-runs the audit.
21. **Redact the interpolated values inside `fitQuestions`, not `redactDeep(questions)`.** `redactDeep`
    rebuilds the SDK's own question objects via `Object.fromEntries(Object.entries(...))` — fine today,
    but it couples redaction to an SDK internal, and because the layer fails *open*, a future branded
    class would surface as "Jev is down" rather than as a bug. *Cost if wrong:* a skill description
    containing a ≥24-char high-entropy token gets masked and the fit judgment loses a little context.
22. **Fix the empty-settings-file residual rather than park it.** A 0-byte `settings.local.json` is a
    plausible real state and has nothing to lose, which is the refusal's own rationale. *Cost if
    wrong:* an empty file is overwritten with a valid settings object — the desired behavior anyway.

---

## Carried forward to Milestone 2

- **`Jev`'s default cache is an unbounded `Map`** with no eviction or TTL.
- **Parked review items:** the settings lockfile (I7) and the two divergent `skillOverrides` readers
  (I8), plus the Minors listed in the final review.
- **`TOKEN_SAVER=off` / `TOKEN_SAVER_MODE=shadow`** appear in the spec's cross-cutting rules but were
  not in Milestone 1's plan and are not in the code.
- **Plugin skill inventory** is unimplemented (`claudePaths` returns no plugin dirs) — see the
  expectation note above.
- **Process lesson worth keeping:** four of the six serious findings in the final review existed
  because a test passed against a fixture that omitted the condition under test. For Milestone 2,
  any test whose subject touches the outside world should have at least one fixture built by copying
  the real thing's shape (`ls ~/.claude/projects`, `ls -la ~/.claude/skills`) rather than from the
  plan's example.

## Unresolved

Two specs coexist and disagree on scope: `2026-09-17-token-saver-design.md` (the one this milestone
executed) and `2026-09-17-token-saver-g-design.md` (a pi-only track from a parallel session, with its
own plan at `2026-09-17-token-saver-g.md`). Reconcile before starting Milestone 2.
