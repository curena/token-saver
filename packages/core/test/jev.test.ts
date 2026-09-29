import { describe, expect, it, vi } from "vitest";
import { Jev } from "../src/jev.js";

const questions = { q: { type: "noul", instructions: "is it?" } };

describe("Jev", () => {
  it("returns null when no client is configured", async () => {
    const jev = new Jev({ client: null });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
  });

  it("redacts state before sending", async () => {
    const seen: unknown[] = [];
    const client = {
      systemOne: async (req: any) => {
        seen.push(req.state);
        return { answers: { q: { noul: 0.9 } } };
      },
    };
    await new Jev({ client }).ask({ log: "API_KEY=abcdefghijklmnopqrstuvwx" }, questions);
    expect(JSON.stringify(seen[0])).toContain("[REDACTED]");
    expect(JSON.stringify(seen[0])).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("returns null when the call exceeds the deadline", async () => {
    const client = {
      systemOne: () => new Promise<any>((resolve) => setTimeout(resolve, 200)),
    };
    const jev = new Jev({ client, deadlineMs: 20 });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
  });

  it("returns null when the client throws", async () => {
    const client = { systemOne: async () => { throw new Error("boom"); } };
    expect(await new Jev({ client }).ask({ a: 1 }, questions)).toBeNull();
  });

  it("serves a repeated request from cache without calling again", async () => {
    const systemOne = vi.fn(async () => ({ answers: { q: { noul: 0.5 } } }));
    const jev = new Jev({ client: { systemOne } });
    await jev.ask({ a: 1 }, questions);
    await jev.ask({ a: 1 }, questions);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("reports usage for both live and cached calls", async () => {
    const events: { cached: boolean; ok: boolean }[] = [];
    const jev = new Jev({
      client: { systemOne: async () => ({ answers: { q: { noul: 0.5 } } }) },
      onUsage: (e) => events.push(e),
    });
    await jev.ask({ a: 1 }, questions);
    await jev.ask({ a: 1 }, questions);
    expect(events.map((e) => e.cached)).toEqual([false, true]);
    expect(events.every((e) => e.ok)).toBe(true);
  });

  it("redacts a circular state instead of throwing", async () => {
    const seen: unknown[] = [];
    const state: Record<string, unknown> = { a: 1 };
    state.self = state;
    const client = {
      systemOne: async (req: any) => {
        seen.push(req.state);
        return { answers: { q: { noul: 0.5 } } };
      },
    };
    // Chosen behavior: the cycle guard elides the self-reference as "[Circular]" so
    // redaction and the call still succeed, rather than losing the judgment to a
    // swallowed exception.
    const result = await new Jev({ client }).ask(state, questions);
    expect(result).toEqual({ q: { noul: 0.5 } });
    expect((seen[0] as any).self).toBe("[Circular]");
  });

  it("keeps a shared acyclic node in both positions", async () => {
    const seen: unknown[] = [];
    const shared = { note: "keep me" };
    const state = { a: shared, b: shared };
    const client = {
      systemOne: async (req: any) => {
        seen.push(req.state);
        return { answers: { q: { noul: 0.5 } } };
      },
    };
    // The cycle guard must track ancestors (added on the way in, deleted on the way out),
    // not everything ever visited — a visited-set guard would elide this shared, non-cyclic
    // node as "[Circular]" the second time it's reached and silently drop real content.
    await new Jev({ client }).ask(state, questions);
    expect(seen[0]).toEqual({ a: { note: "keep me" }, b: { note: "keep me" } });
    expect(JSON.stringify(seen[0])).not.toContain("[Circular]");
  });

  it("does not throw when state contains a BigInt", async () => {
    const client = { systemOne: async () => ({ answers: { q: { noul: 0.5 } } }) };
    const result = await new Jev({ client }).ask({ big: 10n }, questions);
    expect(result).toEqual({ q: { noul: 0.5 } });
  });

  it("returns null when the client resolves without answers", async () => {
    const client = { systemOne: async () => ({}) as any };
    const jev = new Jev({ client });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
  });

  it("does not cache a malformed response", async () => {
    let calls = 0;
    const client = {
      systemOne: async () => {
        calls += 1;
        if (calls === 1) return {} as any;
        return { answers: { q: { noul: 0.7 } } };
      },
    };
    const jev = new Jev({ client });
    expect(await jev.ask({ a: 1 }, questions)).toBeNull();
    expect(await jev.ask({ a: 1 }, questions)).toEqual({ q: { noul: 0.7 } });
    expect(calls).toBe(2);
  });
});
