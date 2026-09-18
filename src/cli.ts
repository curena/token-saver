import { homedir } from "node:os";
import { claudePaths } from "./adapters/claude-code/paths.js";
import { fingerprint } from "./audit/fingerprint.js";
import { scanClaudeCode } from "./audit/inventory-claude-code.js";
import { buildProfile } from "./audit/profile.js";
import { applyProposals, buildProposals, judgeFit, renderProposals, undoLast } from "./audit/run.js";
import { countSkillUses, recentPrompts } from "./audit/usage.js";
import { RECENT_USE_DAYS } from "./core/policy.js";
import { Jev } from "./runtime/jev.js";
import { Store } from "./runtime/store.js";

const PROMPT_LIMIT = 200;
const AUDIT_DEADLINE_MS = 10_000;

const USAGE = `usage:
  token-saver audit [--apply] [--undo]   inventory skills, judge fit, propose settings
  token-saver hook session-start         warn when the setup drifted since the last audit`;

function context() {
  const home = process.env.TOKEN_SAVER_HOME ?? homedir();
  const root = process.env.TOKEN_SAVER_ROOT ?? process.cwd();
  return { home, root, paths: claudePaths(home, root), store: new Store(root) };
}

/** No API key means no client, which means no judgments and so no proposals. */
async function makeJev(cache: Map<string, any>): Promise<Jev> {
  if (!process.env.TYPESAFE_API_KEY) {
    return new Jev({ client: null, cache, deadlineMs: AUDIT_DEADLINE_MS });
  }
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ retry: { maxRetries: 0 } });
  return new Jev({ client: client as any, cache, deadlineMs: AUDIT_DEADLINE_MS });
}

async function audit(flags: string[]): Promise<number> {
  const { root, paths, store } = context();
  if (flags.includes("--undo")) {
    console.log(undoLast(store));
    return 0;
  }

  const items = scanClaudeCode(paths);
  const since = new Date(Date.now() - RECENT_USE_DAYS * 86_400_000);
  const uses = countSkillUses(paths.transcriptDir, since);
  const profile = buildProfile(root, recentPrompts(paths.transcriptDir, PROMPT_LIMIT));

  const cache = store.loadCache("fit");
  const jev = await makeJev(cache);
  const fits = await judgeFit(jev, profile, items.filter((item) => item.managed));
  store.saveCache("fit", cache);

  const proposals = buildProposals(items, fits, uses);
  console.log(renderProposals(proposals));

  if (flags.includes("--apply")) {
    const count = applyProposals(proposals, paths.settingsPath, store, new Date());
    console.log(`Applied ${count} change(s) to ${paths.settingsPath}.`);
  } else if (proposals.length > 0) {
    console.log("\nRun with --apply to write these, and --undo to revert.");
  }

  store.writeFingerprint(fingerprint(profile, items));
  return 0;
}

function sessionStart(): number {
  const { root, paths, store } = context();
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

// Entry point when run as a binary, not when imported by tests.
if (process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
