import { describe, expect, it } from "vitest";
import { estimateTokens } from "@token-saver/core";
import { proposeState } from "../src/policy.js";
import type { InventoryItem } from "../src/types.js";

const item: InventoryItem = {
  id: "pdf",
  name: "pdf",
  kind: "skill",
  harness: "claude-code",
  source: "/home/u/.claude/skills/pdf/SKILL.md",
  description: "Work with PDF files",
  tokens: 120,
  managed: true,
  currentState: "on",
};

describe("proposeState", () => {
  it("keeps a recently used item on, whatever its fit", () => {
    const p = proposeState(item, 4, 3);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/used/);
  });

  it("keeps a core-fit item on", () => {
    expect(proposeState(item, 1, 0).to).toBe("on");
  });

  it("collapses an occasionally useful item to name-only", () => {
    expect(proposeState(item, 2, 0).to).toBe("name-only");
    expect(proposeState(item, 3, 0).to).toBe("name-only");
  });

  it("hides an irrelevant unused item but keeps it user-invocable", () => {
    expect(proposeState(item, 4, 0).to).toBe("user-invocable-only");
  });

  it("never proposes off", () => {
    const states = [1, 2, 3, 4].map((f) => proposeState(item, f as 1, 0).to);
    expect(states).not.toContain("off");
  });

  it("leaves an item alone when fit is unknown", () => {
    const p = proposeState(item, null, 0);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/no judgment/);
  });

  it("does not propose a change for an unmanaged item", () => {
    const p = proposeState({ ...item, managed: false, kind: "plugin-skill" }, 4, 0);
    expect(p.to).toBe("on");
    expect(p.reason).toMatch(/not settable/);
  });

  // A user who set a skill to `off` decided that on purpose. The audit spends tokens, it
  // does not hand them back, so it must never walk a skill *up* the visibility ladder --
  // not on a good fit, and not on recent use either.
  describe("never promotes", () => {
    const off = { ...item, currentState: "off" as const };

    it("leaves an item the user turned off alone, whatever its fit", () => {
      for (const fit of [1, 2, 3, 4] as const) {
        expect(proposeState(off, fit, 0).to).toBe("off");
      }
    });

    it("leaves an off item off even when it was used recently", () => {
      expect(proposeState(off, 4, 5).to).toBe("off");
    });

    it("does not restore a user-invocable-only item to on for a core fit", () => {
      const hidden = { ...item, currentState: "user-invocable-only" as const };
      expect(proposeState(hidden, 1, 0).to).toBe("user-invocable-only");
      expect(proposeState(hidden, 2, 0).to).toBe("user-invocable-only");
    });

    it("still demotes from a partially restricted state", () => {
      const named = { ...item, currentState: "name-only" as const };
      expect(proposeState(named, 4, 0).to).toBe("user-invocable-only");
    });
  });

  // `tokens` is what the change *saves*, not what the item costs. Those are the same
  // number only when the item starts at `on` and ends up fully hidden.
  describe("token saving", () => {
    it("reports the full cost when hiding an item that was fully on", () => {
      expect(proposeState(item, 4, 0).tokens).toBe(120);
    });

    it("discounts the name that name-only leaves behind in context", () => {
      // "pdf" is 3 characters, so estimateTokens rounds it to 1.
      expect(proposeState(item, 2, 0).tokens).toBe(120 - estimateTokens("pdf"));
    });

    it("counts only the remaining name when tightening name-only to hidden", () => {
      const named = { ...item, currentState: "name-only" as const };
      expect(proposeState(named, 4, 0).tokens).toBe(estimateTokens("pdf"));
    });

    it("reports no saving when nothing changes", () => {
      expect(proposeState({ ...item, managed: false }, 4, 0).tokens).toBe(0);
      expect(proposeState({ ...item, currentState: "off" }, 4, 0).tokens).toBe(0);
    });

    it("is never negative", () => {
      const states = ["on", "name-only", "user-invocable-only", "off"] as const;
      for (const currentState of states) {
        for (const fit of [1, 2, 3, 4] as const) {
          for (const uses of [0, 3]) {
            expect(proposeState({ ...item, currentState }, fit, uses).tokens).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });
});
// `estimateTokens` itself now lives in @token-saver/core and is covered by
// packages/core/test/tokens.test.ts, which is a superset of the one case that
// was asserted here.
