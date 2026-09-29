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

/**
 * Recursively redact every string in a JSON-serialisable value.
 *
 * `state` is caller-supplied and typed `unknown`, so it may be a live object graph rather
 * than plain data: `seen` (a `WeakSet` of objects currently on the recursion stack) elides
 * a cycle as `"[Circular]"` instead of recursing forever, and a `bigint` — the one JS
 * primitive `JSON.stringify` throws on — is converted to its string form. Both keep the
 * common case working (redaction still runs, the judgment still gets sent) rather than
 * merely avoiding a crash.
 */
function redactDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = value.map((v) => redactDeep(v, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, seen)]),
    );
    seen.delete(value);
    return result;
  }
  return value;
}

/**
 * Deadline-bound, redacting, caching wrapper. Every failure path returns null so
 * callers fall back to a code-only decision.
 *
 * REDACTION CONTRACT -- read this before adding a question builder.
 * `ask` redacts `state`, and ONLY `state`. It does not redact `questions`, because a
 * question is an SDK-built object rather than plain data, and rebuilding one generically
 * would couple this module to the SDK's internal shape. Every question builder is therefore
 * responsible for redacting anything it interpolates into its own question text. See
 * `fitQuestions` in src/core/questions/fit.ts for the pattern.
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

    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Redaction and the cache key are computed inside this guard too: `state` is
      // `unknown`, so a caller handing us a live object graph (circular references,
      // BigInts) must not escape as an unhandled rejection — it has to fail open like
      // everything else this method does.
      const safeState = redactDeep(state);
      const key = createHash("sha256")
        .update(JSON.stringify({ state: safeState, questions }))
        .digest("hex");

      const hit = this.cache.get(key);
      if (hit) {
        this.onUsage?.({ ms: 0, cached: true, ok: true });
        return hit;
      }

      const response = await Promise.race([
        this.client.systemOne({ state: safeState, questions }, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("token-saver: deadline"));
          }, this.deadlineMs);
        }),
      ]);

      // A client can resolve with a malformed body (e.g. `{}`). Validate before caching
      // or returning it so a bad response fails open through the catch below instead of
      // resolving to `undefined`, which callers checking `result === null` would miss.
      if (
        response == null ||
        typeof response !== "object" ||
        response.answers == null ||
        typeof response.answers !== "object"
      ) {
        throw new Error("token-saver: malformed systemOne response");
      }

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
