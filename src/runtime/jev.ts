import { createHash } from "node:crypto";
import { redact } from "../core/redact.js";

export interface JevClient {
  systemOne(
    request: { state: unknown; questions: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers: Record<string, any> }>;
}

export interface JevOptions {
  client?: JevClient | null;
  deadlineMs?: number;
  cache?: Map<string, Record<string, any>>;
  onUsage?: (event: { ms: number; cached: boolean; ok: boolean }) => void;
}

/** Recursively redact every string in a JSON-serialisable value. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

/**
 * Deadline-bound, redacting, caching wrapper. Every failure path returns null so
 * callers fall back to a code-only decision.
 */
export class Jev {
  private readonly client: JevClient | null;
  private readonly deadlineMs: number;
  private readonly cache: Map<string, Record<string, any>>;
  private readonly onUsage?: JevOptions["onUsage"];

  constructor(options: JevOptions = {}) {
    this.client = options.client ?? null;
    this.deadlineMs = options.deadlineMs ?? 10_000;
    this.cache = options.cache ?? new Map();
    this.onUsage = options.onUsage;
  }

  async ask(
    state: unknown,
    questions: Record<string, unknown>,
  ): Promise<Record<string, any> | null> {
    if (!this.client) return null;
    const safeState = redactDeep(state);
    const key = createHash("sha256")
      .update(JSON.stringify({ state: safeState, questions }))
      .digest("hex");

    const hit = this.cache.get(key);
    if (hit) {
      this.onUsage?.({ ms: 0, cached: true, ok: true });
      return hit;
    }

    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.client.systemOne({ state: safeState, questions }, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("token-saver: deadline"));
          }, this.deadlineMs);
        }),
      ]);
      this.cache.set(key, response.answers);
      this.onUsage?.({ ms: Date.now() - started, cached: false, ok: true });
      return response.answers;
    } catch {
      this.onUsage?.({ ms: Date.now() - started, cached: false, ok: false });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
