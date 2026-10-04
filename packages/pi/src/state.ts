import type { Decision, SweepEntryData } from "@token-saver/prune";

export const SWEEP_ENTRY = "token-saver/sweep";
export const RESTORE_ENTRY = "token-saver/restore";

export interface RestoreEntryData {
  id: string;
}

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
    // pi's buildContextEntries() puts the latest compaction first, then the kept tail (with
    // its sweep entries), then newer entries, so nothing live is dropped here. On a raw log,
    // results before a compaction are gone from the context and their decisions are noise.
    const lastCompaction = entries.map((entry) => entry.type).lastIndexOf("compaction");
    for (const entry of entries.slice(lastCompaction + 1)) {
      if (entry.type !== "custom") continue;
      if (entry.customType === RESTORE_ENTRY) {
        const id = (entry.data as Partial<RestoreEntryData> | undefined)?.id;
        if (typeof id === "string") this.pin(id);
        continue;
      }
      if (entry.customType !== SWEEP_ENTRY) continue;
      const data = entry.data as Partial<SweepEntryData> | undefined;
      if (!Array.isArray(data?.decisions)) continue;
      this.add(data.decisions);
    }
  }

  remove(id: string): boolean {
    return this.decisions.delete(id);
  }

  /**
   * /token-saver restore: replace a shortening with a permanent "leave" decision.
   * Being decided, the result is never eligible again, so later sweeps can't
   * re-shorten it. Returns false when there was nothing shortened to restore.
   */
  restore(id: string): boolean {
    const existing = this.decisions.get(id);
    if (existing === undefined || existing.level === "leave") return false;
    this.pin(id, existing.decidedAtTurn);
    return true;
  }

  private pin(id: string, decidedAtTurn = this.decisions.get(id)?.decidedAtTurn ?? 0): void {
    this.decisions.set(id, {
      id, level: "leave", rendered: null, savedTokens: 0, reason: "judged", keptChunks: [], decidedAtTurn,
    });
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
