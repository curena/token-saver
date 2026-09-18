# Replay baseline

**Status: Not yet run.** `TYPESAFE_API_KEY` was not set in the environment, so the
real replay over recorded sessions could not execute. The exact command to run
once the key is available is recorded below; `keepThreshold` stays at the spec
default until the run says otherwise.

## Command

```bash
export TYPESAFE_API_KEY=...   # ask the user; never commit it
npx tsx packages/replay/src/cli.ts ~/.pi/agent/sessions --tau 0.1,0.2,0.3,0.5 --report out/baseline
```

- Session directory: `~/.pi/agent/sessions`
- Tau values to try: `0.1, 0.2, 0.3, 0.5`
- `keepThreshold` remains at `0.3` (spec default); change `packages/core/src/config.ts` only if the data says so.

## To fill in after the run

- Date of the run
- Report table (one row per tau)
- Number of sessions and calls
- Misses per tau, with their probabilities
- The chosen `keepThreshold`: the largest tau whose miss count stays at zero, or (if every tau misses) the tau where misses stop falling as savings rise.
