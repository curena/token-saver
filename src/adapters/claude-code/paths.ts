import { join } from "node:path";

export function projectSlug(root: string): string {
  return root.replace(/[/\\:]/g, "-");
}

export function claudePaths(home: string, root: string) {
  return {
    userSkillsDir: join(home, ".claude", "skills"),
    projectSkillsDir: join(root, ".claude", "skills"),
    settingsPath: join(root, ".claude", "settings.local.json"),
    transcriptDir: join(home, ".claude", "projects", projectSlug(root)),
  };
}
