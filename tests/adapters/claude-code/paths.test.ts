import { describe, expect, it } from "vitest";
import { claudePaths, projectSlug } from "../../../src/adapters/claude-code/paths.js";

describe("projectSlug", () => {
  it("replaces separators with dashes", () => {
    expect(projectSlug("/home/u/proj")).toBe("-home-u-proj");
  });

  it("handles a nested path", () => {
    expect(projectSlug("/home/u/work/proj")).toBe("-home-u-work-proj");
  });

  it("replaces dots too, matching the slug Claude Code actually writes", () => {
    // Ground truth observed on a real machine: a worktree path under `.claude/` slugs with
    // `--claude`, not `-.claude`. Getting this wrong is silent -- countSkillUses and
    // recentPrompts just find no transcript directory and return empty.
    expect(projectSlug("/home/archie/workspace/token-saver/.claude/worktrees/milestone-1-plan"))
      .toBe("-home-archie-workspace-token-saver--claude-worktrees-milestone-1-plan");
  });

  it("replaces every character that is not alphanumeric or a dash", () => {
    expect(projectSlug("/home/u/my proj(v2)")).toBe("-home-u-my-proj-v2-");
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
