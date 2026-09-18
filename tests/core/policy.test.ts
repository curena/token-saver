import { describe, expect, it } from "vitest";
import { estimateTokens, proposeState } from "../../src/core/policy.js";
import type { InventoryItem } from "../../src/core/types.js";

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
});

describe("estimateTokens", () => {
  it("estimates four characters per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });
});
