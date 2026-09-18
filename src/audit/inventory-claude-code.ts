import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isDenylistedPath } from "../core/redact.js";
import { estimateTokens } from "../core/policy.js";
import type { InventoryItem, SkillState } from "../core/types.js";

export interface ScanOptions {
  userSkillsDir: string;
  projectSkillsDir: string;
  pluginSkillDirs?: string[];
  settingsPath: string;
}

const STATES: string[] = ["on", "name-only", "user-invocable-only", "off"];

/**
 * Read `skillOverrides` from a Claude Code settings file. Fails open to `{}`
 * on every kind of trouble: the file missing, empty, not JSON, `skillOverrides`
 * not shaped like an object, or an individual value that isn't a known state.
 * The settings path itself is checked against the path denylist first, since
 * this module must not read secrets-shaped paths off disk even when a caller
 * points it at one.
 */
export function readSkillOverrides(settingsPath: string): Record<string, SkillState> {
  if (isDenylistedPath(settingsPath)) return {};
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      skillOverrides?: Record<string, string>;
    };
    const out: Record<string, SkillState> = {};
    for (const [name, state] of Object.entries(parsed?.skillOverrides ?? {})) {
      if (STATES.includes(state)) out[name] = state as SkillState;
    }
    return out;
  } catch {
    return {};
  }
}

/** Minimal frontmatter reader: `key: value` lines between the leading --- fences. */
function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

/**
 * Read and parse one skill's SKILL.md. Returns null (never throws) when the
 * path is denylisted, the file doesn't exist, can't be read (permissions, or
 * a directory sitting where SKILL.md should be), or has no usable
 * description once parsed — every one of those is "no skill here", not an
 * error the caller should crash on.
 */
function readSkill(source: string): { name: string; description: string } | null {
  if (isDenylistedPath(source)) return null;
  if (!existsSync(source)) return null;
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    return null;
  }
  const fields = parseFrontmatter(text);
  if (!fields.description) return null;
  const description = fields.when_to_use
    ? `${fields.description} ${fields.when_to_use}`
    : fields.description;
  return { name: fields.name || "", description };
}

function scanDir(
  dir: string,
  kind: InventoryItem["kind"],
  overrides: Record<string, SkillState>,
): InventoryItem[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Permissions, or `dir` turned out not to be a directory after all.
    return [];
  }
  const items: InventoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(dir, entry.name, "SKILL.md");
    const skill = readSkill(source);
    if (!skill) continue;
    const name = skill.name || entry.name;
    items.push({
      id: name,
      name,
      kind,
      harness: "claude-code",
      source,
      description: skill.description,
      tokens: estimateTokens(`${name}: ${skill.description}`),
      managed: kind === "skill",
      currentState: overrides[name] ?? "on",
    });
  }
  return items;
}

export function scanClaudeCode(options: ScanOptions): InventoryItem[] {
  const overrides = readSkillOverrides(options.settingsPath);
  return [
    ...scanDir(options.userSkillsDir, "skill", overrides),
    ...scanDir(options.projectSkillsDir, "skill", overrides),
    ...(options.pluginSkillDirs ?? []).flatMap((dir) => scanDir(dir, "plugin-skill", overrides)),
  ];
}
