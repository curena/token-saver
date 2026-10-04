import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.js";
import type { InventoryItem, ProjectProfile } from "../src/types.js";

const profile: ProjectProfile = { root: "/p", readme: "r", manifests: [], tree: ["src/"], prompts: ["x"] };
const item: InventoryItem = {
  id: "pdf", name: "pdf", kind: "skill", harness: "claude-code", source: "/s",
  description: "PDFs", tokens: 10, managed: true, currentState: "on",
};

describe("fingerprint", () => {
  it("is stable for the same inputs", () => {
    expect(fingerprint(profile, [item])).toBe(fingerprint(profile, [item]));
  });

  it("changes when a skill is added", () => {
    const other = { ...item, id: "docx", name: "docx" };
    expect(fingerprint(profile, [item, other])).not.toBe(fingerprint(profile, [item]));
  });

  it("ignores prompt churn, which changes every session", () => {
    const busier = { ...profile, prompts: ["totally different"] };
    expect(fingerprint(busier, [item])).toBe(fingerprint(profile, [item]));
  });

  it("changes when the README changes", () => {
    expect(fingerprint({ ...profile, readme: "new" }, [item])).not.toBe(fingerprint(profile, [item]));
  });
});
