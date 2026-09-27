export type SkillState = "on" | "name-only" | "user-invocable-only" | "off";

export type FitLevel = 1 | 2 | 3 | 4;

export interface InventoryItem {
  /** Stable key: the skill name as settings and transcripts refer to it. */
  id: string;
  name: string;
  kind: "skill" | "plugin-skill";
  harness: "claude-code" | "pi";
  /** Absolute path of the SKILL.md this came from. */
  source: string;
  description: string;
  /** Estimated tokens this item costs in every session's prompt. */
  tokens: number;
  /** False when the harness has no per-project switch for it (plugin skills). */
  managed: boolean;
  currentState: SkillState;
}

export interface ProjectProfile {
  root: string;
  readme: string;
  manifests: string[];
  tree: string[];
  prompts: string[];
}

export interface Proposal {
  id: string;
  name: string;
  from: SkillState;
  to: SkillState;
  fit: FitLevel | null;
  uses: number;
  /** Tokens per session this change would save -- never the item's absolute cost. */
  tokens: number;
  reason: string;
}
