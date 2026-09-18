# OQ-1: Can a pi extension hide skills per session at runtime?

**Status: partially answered. OQ-1 remains open on the question that matters most for the adapter design (whether a mutated skill list actually changes what pi sends to the model / what it replies with).**

## What I ran

Environment: `pi` 0.85.1 at `~/.nvm/versions/node/v24.19.0/bin/pi`, run from
`probes/pi-skills/` inside this worktree. Nothing under `~/.pi/` was written.

### 1. Sanity checks (before the probe)

```
$ pi --version
0.85.1
```

`pi --help` confirms `--extension, -e <path>` and `--print, -p` exist as documented in the brief,
and that `before_agent_start` is not itself listed in `--help` (event names aren't part of the
CLI help; this is expected — the brief's event name was tried directly, see below).

A non-credential-revealing readiness check (status/provider/reason only, no key material):

```
$ pi auth check --provider google --json
{"status":"not_ready","provider":"google","reason":"credentials_not_configured"}
```

`google` is pi's documented default provider (`--provider <name>  Provider name (default: google)`
per `pi --help`), and it is not configured for this user. I did not read `~/.pi/agent/auth.json`
or `~/.pi/agent/settings.json` to find out what provider *is* configured — the harness's own
permission layer blocked that read as credential exploration, and the task explicitly says not to
go looking for the user's credentials, so I stopped there and let the actual probe run tell me
what happens.

### 2. The probe extension

Written verbatim from the brief, no changes needed:

`probes/pi-skills/extension.ts`:
```ts
export default function (pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    const skills = event.systemPromptOptions?.skills;
    console.error(`[probe] skills: ${Array.isArray(skills) ? skills.length : typeof skills}`);
    if (Array.isArray(skills) && skills.length > 1) {
      const removed = skills.splice(1); // keep only the first skill
      console.error(`[probe] removed ${removed.length}: ${removed.map((s: any) => s?.name).join(", ")}`);
    }
    return {};
  });
}
```

### 3. Running it (brief's Step 2, verbatim command)

```
$ cd probes/pi-skills && pi --extension ./extension.ts -p "List every skill you can see, by name, and nothing else."
[probe] skills: 19
[probe] removed 18: hf-cli, brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills, memory-setup, council-mode, pi-subagents
403 "This authentication method does not have sufficient permissions to call Inference Providers on behalf of user curenaaa"
```

Exit code: 1.

I did not retry with a different `--provider` or otherwise try to fix authentication — the brief
and task constraints say to stop and report exactly this situation rather than attempt to
authenticate or hunt for credentials. This was the single invocation the task authorized; I made
no further calls to pi.

## Answering the brief's four questions

**Did `systemPromptOptions.skills` exist, and what shape was it?**
OBSERVED: yes. `event.systemPromptOptions.skills` was an array of 19 entries. Each entry has at
least a `.name` field (the removed-entries log line printed 18 real skill names: `hf-cli`,
`brainstorming`, `dispatching-parallel-agents`, ..., `pi-subagents` — recognizable skill/plugin
names matching what's installed in this environment). This confirms the hook fires before the
model call and the option object is a live, mutable array at that point, not a frozen snapshot.

**Did removing entries change the skills pi listed in its reply?**
NOT OBSERVED. The `splice(1)` call executed in-process without throwing (18 elements removed,
1 kept), so the extension-side mutation succeeded. But the underlying model call then failed
with a 403 permissions error before pi produced any reply text. There is no reply to compare
against — I cannot say whether pi's actual system prompt (the thing sent to the model) reflected
the post-splice list of 1 skill or the original list of 19. This is the crux of OQ-1 and it is
unanswered.

**Did pi log a prompt-section patch, or replace the whole system prompt (a cache miss)?**
NOT OBSERVED. No such log line appeared, in either direction, in the captured output (stderr and
stdout, shown in full above). The process errored out at the provider-call stage (a 403 from what
the error message calls "Inference Providers") before, as far as the visible output shows, any
prompt-construction/caching diagnostic was printed. pi may not log this at all by default (no
`--verbose` was used, since a second invocation would have exceeded the task's single-call
budget) — I can't distinguish "pi doesn't log this" from "it never got far enough to log it."

**Verdict: can pi's audit hide skills per session, or must it fall back to filtering package skill lists in settings?**
OQ-1 is still open. What's OBSERVED and solid: a pi extension's `before_agent_start` hook exists,
fires before the agent call, and receives a mutable `systemPromptOptions.skills` array that an
extension can freely truncate/splice with no runtime error. That much is a genuine, evidence-backed
signal that per-session skill hiding via an extension is architecturally *plausible* — pi hands
extensions a live handle to the exact list, at the exact point, the brief hypothesized.
What's NOT observed, and is the actual deciding fact for the adapter: whether that mutation
propagates into the system prompt actually sent to the model (proving per-session hiding works),
or whether pi already builds/caches the prompt before this hook runs (which would mean the mutation
is a no-op and the audit would have to fall back to editing package skill lists in settings). The
probe could not reach that answer because the configured inference credentials in this environment
returned a 403 ("This authentication method does not have sufficient permissions to call Inference
Providers"), which is an auth/permissions problem unrelated to the extension mechanism.

**From source/docs, not observed:** none consulted. This note is based solely on the single probe
run above; pi's source and docs were not read to fill the gap, per the task's rule against
inferring the answer from reading rather than observing it.

## What would resolve OQ-1

Re-run the exact same probe command once pi has working inference credentials (any provider). The
two log lines already prove the hook and mutable-array shape exist; the only missing evidence is
whether pi's actual reply lists 1 skill or 19, and whether a prompt-patch/cache-miss log line
appears around the API call. That is a single additional invocation, not a redesign of the probe.
