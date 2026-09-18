import type { Decision, SweepEntryData } from "@token-saver/core";

export const SWEEP_ENTRY = "token-saver/sweep";

export class DecisionStore {
  private decisions = new Map<string, Decision>();

  get(): ReadonlyMap<string, Decision> {
    return this.decisions;
  }

  add(decisions: Decision[]): void {
    for (const decision of decisions) {
      // Decisions are immutable: the first one wins, forever.
      if (!this.decisions.has(decision.id)) this.decisions.set(decision.id, decision);
    }
  }

  rebuildFrom(entries: Array<{ type: string; customType?: string; data?: unknown }>): void {
    this.decisions.clear();
    // Results before a compaction are gone from the context, so their decisions are noise.
    const lastCompaction = entries.map((entry) => entry.type).lastIndexOf("compaction");
    for (const entry of entries.slice(lastCompaction + 1)) {
      if (entry.type !== "custom" || entry.customType !== SWEEP_ENTRY) continue;
      const data = entry.data as Partial<SweepEntryData> | undefined;
      if (!Array.isArray(data?.decisions)) continue;
      this.add(data.decisions);
    }
  }

  remove(id: string): boolean {
    return this.decisions.delete(id);
  }

  stats(): { stubbed: number; partial: number; savedTokens: number } {
    let stubbed = 0;
    let partial = 0;
    let savedTokens = 0;
    for (const decision of this.decisions.values()) {
      if (decision.level === "stub") stubbed++;
      if (decision.level === "partial") partial++;
      savedTokens += decision.savedTokens;
    }
    return { stubbed, partial, savedTokens };
  }
}
