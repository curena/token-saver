import { join } from "node:path";

/**
 * Claude Code's own transcript-directory slug: every character outside [A-Za-z0-9-] becomes
 * a dash. Notably that includes `.`, so `/p/.claude/x` slugs to `-p--claude-x` (two dashes),
 * not `-p-.claude-x`. Getting this wrong fails silently -- the transcript directory simply
 * doesn't exist, so usage counts and recent prompts come back empty.
 */
export function projectSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9-]/g, "-");
}

export function claudePaths(home: string, root: string) {
  return {
    userSkillsDir: join(home, ".claude", "skills"),
    projectSkillsDir: join(root, ".claude", "skills"),
    settingsPath: join(root, ".claude", "settings.local.json"),
    transcriptDir: join(home, ".claude", "projects", projectSlug(root)),
  };
}
