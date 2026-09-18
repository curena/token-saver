# token-saver

Cuts an agent's token use by putting small TypeSafe Jev judgments in front of its decisions.
Milestone 1 ships the setup audit for Claude Code.

## Install

```bash
npm install && npm run build && npm link
```

Set `TYPESAFE_API_KEY` in your environment. Without it the audit still runs, but proposes
nothing.

## Use

```bash
token-saver audit            # show proposed skill visibility changes
token-saver audit --apply    # write them to .claude/settings.local.json
token-saver audit --undo     # revert the last applied change
```

Add the `SessionStart` hook from `src/adapters/claude-code/hooks.json` to your settings to be
reminded when your skills or project drift enough to warrant a fresh audit.

The audit never proposes `off`, so every skill stays available as `/name`.

## Redaction

Before any project data (README, manifests, file tree, recent prompts) is sent to Jev, it's
run through a redaction pass. A path matching the denylist is never read for this purpose at
all:

- `.env*`
- `*.pem`
- `id_*`
- `secrets/**`

Everything else is scanned for high-entropy strings (API keys, tokens) and redacted in place
before it leaves your machine.

Design: `docs/superpowers/specs/2026-09-17-token-saver-design.md`
