export interface CliArgs {
  targets: string[];
  tau: number[];
  report: string;
}

/** Parse positional session targets plus the --tau and --report flags,
 * consuming each flag's value as a pair so a value like "out/" is never
 * mistaken for a session path. */
export function parseArgs(argv: string[]): CliArgs {
  const targets: string[] = [];
  let tau = [0.3];
  let report = "out";
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
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    targets.push(arg);
  }
  return { targets, tau, report };
}
