import type { SweepEntryData } from "@token-saver/prune";

export function renderSweepEntry(data: SweepEntryData): string {
  const saved = data.decisions.reduce((sum, decision) => sum + decision.savedTokens, 0);
  const shortened = data.decisions.length;
  const approx = saved >= 1000 ? `~${(saved / 1000).toFixed(1)}k` : `~${saved}`;
  return `token-saver  ${shortened} result${shortened === 1 ? "" : "s"} shortened · ${approx} tokens freed`;
}
