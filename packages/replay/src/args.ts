export interface CliArgs {
  targets: string[];
  tau: number[];
  report: string;
  /** Context window for every session; overrides the models file. */
  window: number | null;
  /** pi's compaction.reserveTokens. */
  reserve: number;
  /** pi models-store.json, for per-model context windows. */
  models: string | null;
}

/** Parse positional session targets plus the --tau, --report, --window, --reserve
 * and --models flags, consuming each flag's value as a pair so a value like
 * "out/" is never mistaken for a session path. */
export function parseArgs(argv: string[]): CliArgs {
  const targets: string[] = [];
  let tau = [0.3];
  let report = "out";
  let window: number | null = null;
  let reserve = 16384;
  let models: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tau") {
      tau = (argv[++i] ?? "0.3").split(",").map(Number);
      continue;
    }
    if (arg === "--report") {
      report = argv[++i] ?? "out";
      continue;
    }
    if (arg === "--window") {
      window = Number(argv[++i]);
      continue;
    }
    if (arg === "--reserve") {
      reserve = Number(argv[++i]);
      continue;
    }
    if (arg === "--models") {
      models = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    targets.push(arg);
  }
  return { targets, tau, report, window, reserve, models };
}
