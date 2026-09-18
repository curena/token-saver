import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  at: string;
  /** Settings file the change was written to. */
  file: string;
  /** Previous value of each key; a key absent here did not exist before. */
  previous: Record<string, string>;
  applied: Record<string, string>;
}

type Kind = "cache" | "audit" | "recall" | "log";

/** Everything token-saver persists lives under <project>/.token-saver/. */
export class Store {
  readonly base: string;

  constructor(root: string) {
    this.base = join(root, ".token-saver");
  }

  dir(kind: Kind): string {
    const path = join(this.base, kind);
    mkdirSync(path, { recursive: true });
    return path;
  }

  loadCache(name: string): Map<string, any> {
    const file = join(this.dir("cache"), `${name}.json`);
    if (!existsSync(file)) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8"))));
    } catch {
      return new Map();
    }
  }

  saveCache(name: string, cache: Map<string, any>): void {
    const file = join(this.dir("cache"), `${name}.json`);
    writeFileSync(file, JSON.stringify(Object.fromEntries(cache)), "utf8");
  }

  appendAudit(entry: AuditEntry): void {
    appendFileSync(join(this.dir("audit"), "log.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  lastAudit(): AuditEntry | null {
    const file = join(this.dir("audit"), "log.jsonl");
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]) as AuditEntry;
  }

  readFingerprint(): string | null {
    const file = join(this.dir("audit"), "fingerprint");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  }

  writeFingerprint(value: string): void {
    writeFileSync(join(this.dir("audit"), "fingerprint"), value, "utf8");
  }
}
