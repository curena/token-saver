import { describe, expect, it } from "vitest";
import { claudePaths, projectSlug } from "../../../src/adapters/claude-code/paths.js";

describe("projectSlug", () => {
  it("replaces separators with dashes", () => {
    expect(projectSlug("/home/u/proj")).toBe("-home-u-proj");
  });

  it("handles a nested path", () => {
    expect(projectSlug("/home/u/work/proj")).toBe("-home-u-work-proj");
  });
});

describe("claudePaths", () => {
  it("points at the standard locations", () => {
    const p = claudePaths("/home/u", "/home/u/proj");
    expect(p.userSkillsDir).toBe("/home/u/.claude/skills");
    expect(p.projectSkillsDir).toBe("/home/u/proj/.claude/skills");
    expect(p.settingsPath).toBe("/home/u/proj/.claude/settings.local.json");
    expect(p.transcriptDir).toBe("/home/u/.claude/projects/-home-u-proj");
  });
});
