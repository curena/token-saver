import { describe, expect, it, vi } from "vitest";
import { Jev } from "../../src/runtime/jev.js";

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
});
