#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claudePaths } from "./adapters/claude-code/paths.js";
import { fingerprint } from "./audit/fingerprint.js";
import { scanClaudeCode } from "./audit/inventory-claude-code.js";
import { buildProfile } from "./audit/profile.js";
import {
  applyProposals,
  buildProposals,
  judgeFit,
  MalformedSettingsError,
  renderProposals,
  undoLast,
} from "./audit/run.js";
import { countSkillUses, recentPrompts } from "./audit/usage.js";
import { RECENT_USE_DAYS } from "./core/policy.js";
import { Jev } from "./runtime/jev.js";
import { Store } from "./runtime/store.js";

const PROMPT_LIMIT = 200;
const AUDIT_DEADLINE_MS = 10_000;

/**
 * Per-attempt SDK timeout, deliberately shorter than AUDIT_DEADLINE_MS.
 *
 * TypeSafeClientConfig.timeout defaults to 10000ms -- exactly our deadline. Two independent
 * 10s timers racing means an audit timeout surfaces nondeterministically as either the SDK's
 * APITimeoutError or our own deadline abort. Keeping the SDK's strictly inside ours makes our
 * deadline the unambiguous outer bound.
 */
const SDK_TIMEOUT_MS = 9_000;

const USAGE = `usage:
  token-saver audit [--apply] [--undo]   inventory skills, judge fit, propose settings
  token-saver hook session-start         warn when the setup drifted since the last audit`;

const KNOWN_AUDIT_FLAGS = new Set(["--apply", "--undo"]);

function context() {
  const home = process.env.TOKEN_SAVER_HOME ?? homedir();
  const root = process.env.TOKEN_SAVER_ROOT ?? process.cwd();
  return { home, root, paths: claudePaths(home, root), store: new Store(root) };
}

/**
 * No API key means no client, which means no judgments and so no proposals. `usage` is
 * mutated through Jev's own `onUsage` hook so the caller can tell a clean audit (nothing
 * wrong, judgments just weren't needed or all agreed) apart from a degraded one (the key
 * is present but every call errored or timed out) without Jev itself needing to know
 * anything about rendering.
 */
async function makeJev(cache: Map<string, any>, usage: { total: number; failed: number }): Promise<Jev> {
  const onUsage = (event: { ok: boolean }) => {
    usage.total += 1;
    if (!event.ok) usage.failed += 1;
  };
  if (!process.env.TYPESAFE_API_KEY) {
    return new Jev({ client: null, cache, deadlineMs: AUDIT_DEADLINE_MS, onUsage });
  }
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ retry: { maxRetries: 0 }, timeout: SDK_TIMEOUT_MS });
  return new Jev({ client: client as any, cache, deadlineMs: AUDIT_DEADLINE_MS, onUsage });
}

async function audit(flags: string[]): Promise<number> {
  const unknown = flags.filter((flag) => !KNOWN_AUDIT_FLAGS.has(flag));
  if (unknown.length > 0) {
    console.error(`token-saver: unknown flag(s) for audit: ${unknown.join(", ")}\n\n${USAGE}`);
    return 1;
  }
  if (flags.includes("--apply") && flags.includes("--undo")) {
    console.error(`token-saver: --apply and --undo are mutually exclusive.\n\n${USAGE}`);
    return 1;
  }

  const { root, paths, store } = context();
  if (flags.includes("--undo")) {
    try {
      console.log(undoLast(store, new Date()));
    } catch (err) {
      if (err instanceof MalformedSettingsError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
    return 0;
  }

  const items = scanClaudeCode(paths);
  const since = new Date(Date.now() - RECENT_USE_DAYS * 86_400_000);
  const uses = countSkillUses(paths.transcriptDir, since);
  const profile = buildProfile(root, recentPrompts(paths.transcriptDir, PROMPT_LIMIT, since));

  const cache = store.loadCache("fit");
  const usage = { total: 0, failed: 0 };
  const jev = await makeJev(cache, usage);
  const fits = await judgeFit(jev, profile, items.filter((item) => item.managed));
  store.saveCache("fit", cache);

  // Fail open means the audit still runs and still exits 0 on a degraded Jev -- but a
  // human reading only the proposal table can't tell "nothing needed changing" apart
  // from "every judgment errored and this is code-only". Surface that distinction
  // explicitly rather than let a degraded run look identical to a clean one.
  if (usage.failed > 0) {
    console.error(
      `token-saver: ${usage.failed} of ${usage.total} fit judgment${usage.total === 1 ? "" : "s"} ` +
        "unavailable (errors or timeouts); proposals below are based on usage data alone for the affected skills.",
    );
  }

  const proposals = buildProposals(items, fits, uses);
  console.log(renderProposals(proposals));

  if (flags.includes("--apply")) {
    try {
      const count = applyProposals(proposals, paths.settingsPath, store, new Date());
      console.log(`Applied ${count} change(s) to ${paths.settingsPath}.`);
    } catch (err) {
      if (err instanceof MalformedSettingsError) {
        console.error(err.message);
        // Deliberately return before writing the fingerprint: nothing was applied, so the
        // next session-start must still see this setup as un-audited rather than current.
        return 1;
      }
      throw err;
    }
  } else if (proposals.length > 0) {
    console.log("\nRun with --apply to write these, and --undo to revert.");
  }

  store.writeFingerprint(fingerprint(profile, items));
  return 0;
}

function sessionStart(): number {
  const { root, paths, store } = context();
  // Read-only existence check, deliberately not `store.readFingerprint()`: that method
  // routes through `Store.dir()`, which unconditionally `mkdirSync`s `.token-saver/audit/`
  // even when there's nothing to read. On a project that has never been audited, that
  // would make this "it only ever prints a reminder" hook create state on disk -- the one
  // thing it must never do. A plain existsSync on the fingerprint path never creates
  // anything, so there's nothing to compare against and nothing to report here.
  const fingerprintPath = join(store.base, "audit", "fingerprint");
  if (!existsSync(fingerprintPath)) return 0;

  const items = scanClaudeCode(paths);
  const profile = buildProfile(root, []);
  const current = fingerprint(profile, items);
  const previous = store.readFingerprint();
  if (previous && previous !== current) {
    console.log(
      JSON.stringify({
        systemMessage:
          "token-saver: your skills or project changed since the last audit. Run `token-saver audit`.",
      }),
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "audit") return audit(rest);
  if (command === "hook" && rest[0] === "session-start") return sessionStart();
  console.log(USAGE);
  return 1;
}

/**
 * True when this module is the program Node was asked to run, rather than an import.
 *
 * Compared by URL, not by filename: `npm link` puts a symlink on PATH, so `process.argv[1]`
 * is `<prefix>/bin/token-saver` and an `endsWith("cli.js")` check is false -- the published
 * binary would run, do nothing at all, and exit 0.
 *
 * `realpathSync` is required, not belt-and-braces: Node resolves symlinks when it loads the
 * module, so `import.meta.url` is the real path of dist/cli.js, while `process.argv[1]` keeps
 * whatever path the user typed. Comparing those two directly is false for exactly the
 * npm-symlink case this guard exists to fix. Verified by running through such a symlink.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `process.exitCode` rather than `process.exit(code)`: console.log to a pipe is async on
  // Linux, and process.exit discards whatever is still buffered -- which for the
  // SessionStart hook is the JSON payload itself. Setting the code and letting Node exit
  // naturally flushes first.
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Without this, a throw surfaces as a raw unhandled-rejection stack trace -- in the
      // SessionStart hook, that lands at the top of the user's session.
      console.error(`token-saver: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
