import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanClaudeCode } from "../src/inventory.js";

let root: string;

function writeSkill(dir: string, name: string, frontmatter: string, body = "Body text.") {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-inv-"));
  for (const d of ["user", "project", "plugin"]) mkdirSync(join(root, d), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function scan() {
  return scanClaudeCode({
    userSkillsDir: join(root, "user"),
    projectSkillsDir: join(root, "project"),
    pluginSkillDirs: [join(root, "plugin")],
    settingsPath: join(root, "settings.local.json"),
  });
}

describe("scanClaudeCode", () => {
  it("finds skills in the user and project directories", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: Work with PDFs");
    writeSkill(join(root, "project"), "deploy", "name: deploy\ndescription: Ship the app");
    expect(scan().map((i) => i.id).sort()).toEqual(["deploy", "pdf"]);
  });

  it("reads the description from frontmatter and estimates tokens", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: Work with PDF files");
    const item = scan()[0];
    expect(item.description).toBe("Work with PDF files");
    expect(item.tokens).toBeGreaterThan(0);
  });

  it("appends when_to_use to the description", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs\nwhen_to_use: When a .pdf is mentioned");
    expect(scan()[0].description).toBe("PDFs When a .pdf is mentioned");
  });

  it("marks plugin skills unmanaged", () => {
    writeSkill(join(root, "plugin"), "chart", "name: chart\ndescription: Make charts");
    const item = scan()[0];
    expect(item.kind).toBe("plugin-skill");
    expect(item.managed).toBe(false);
  });

  it("reads the current state from skillOverrides", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(
      join(root, "settings.local.json"),
      JSON.stringify({ skillOverrides: { pdf: "name-only" } }),
      "utf8",
    );
    expect(scan()[0].currentState).toBe("name-only");
  });

  it("defaults the state to on when settings do not mention the skill", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    expect(scan()[0].currentState).toBe("on");
  });

  it("skips a directory without SKILL.md", () => {
    mkdirSync(join(root, "user", "not-a-skill"), { recursive: true });
    expect(scan()).toHaveLength(0);
  });

  it("skips a skill whose frontmatter has no description", () => {
    writeSkill(join(root, "user"), "bare", "name: bare");
    expect(scan()).toHaveLength(0);
  });

  it("survives a missing skills directory", () => {
    rmSync(join(root, "project"), { recursive: true, force: true });
    expect(() => scan()).not.toThrow();
  });

  it("survives a settings file that is not JSON", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(join(root, "settings.local.json"), "{not json", "utf8");
    expect(() => scan()).not.toThrow();
    expect(scan()[0].currentState).toBe("on");
  });

  it("survives an empty settings file", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(join(root, "settings.local.json"), "", "utf8");
    expect(() => scan()).not.toThrow();
    expect(scan()[0].currentState).toBe("on");
  });

  it("ignores skillOverrides that is not an object", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(
      join(root, "settings.local.json"),
      JSON.stringify({ skillOverrides: "not-an-object" }),
      "utf8",
    );
    expect(() => scan()).not.toThrow();
    expect(scan()[0].currentState).toBe("on");
  });

  it("ignores an unknown state value in skillOverrides", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeFileSync(
      join(root, "settings.local.json"),
      JSON.stringify({ skillOverrides: { pdf: "disabled-forever" } }),
      "utf8",
    );
    expect(scan()[0].currentState).toBe("on");
  });

  it("survives a settings file that is a directory", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    mkdirSync(join(root, "settings.local.json"), { recursive: true });
    expect(() => scan()).not.toThrow();
    expect(scan()[0].currentState).toBe("on");
  });

  it("skips a skill whose SKILL.md is actually a directory", () => {
    mkdirSync(join(root, "user", "weird", "SKILL.md"), { recursive: true });
    expect(() => scan()).not.toThrow();
    expect(scan()).toHaveLength(0);
  });

  it("skips a skill whose frontmatter has no closing fence", () => {
    const path = join(root, "user", "broken");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "---\nname: broken\ndescription: Broken\n", "utf8");
    expect(scan()).toHaveLength(0);
  });

  it("skips a skill with no frontmatter block at all", () => {
    const path = join(root, "user", "nofm");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "Just a plain markdown file.\n", "utf8");
    expect(() => scan()).not.toThrow();
    expect(scan()).toHaveLength(0);
  });

  it("ignores a plain file sitting in the skills directory", () => {
    writeFileSync(join(root, "user", "notes.txt"), "hello", "utf8");
    expect(() => scan()).not.toThrow();
    expect(scan()).toHaveLength(0);
  });

  it("refuses to read a settings path that matches the secrets denylist", () => {
    const denied = join(root, ".env");
    writeFileSync(denied, JSON.stringify({ skillOverrides: { pdf: "off" } }), "utf8");
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    const items = scanClaudeCode({
      userSkillsDir: join(root, "user"),
      projectSkillsDir: join(root, "project"),
      pluginSkillDirs: [join(root, "plugin")],
      settingsPath: denied,
    });
    expect(items[0].currentState).toBe("on");
  });

  it("survives a missing project directory and a missing plugin directory together", () => {
    rmSync(join(root, "project"), { recursive: true, force: true });
    rmSync(join(root, "plugin"), { recursive: true, force: true });
    expect(scanClaudeCode({
      userSkillsDir: join(root, "user"),
      projectSkillsDir: join(root, "project"),
      pluginSkillDirs: [join(root, "plugin")],
      settingsPath: join(root, "settings.local.json"),
    })).toEqual([]);
  });

  it("works when pluginSkillDirs is omitted", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    const items = scanClaudeCode({
      userSkillsDir: join(root, "user"),
      projectSkillsDir: join(root, "project"),
      settingsPath: join(root, "settings.local.json"),
    });
    expect(items.map((i) => i.id)).toEqual(["pdf"]);
  });

  it("lets a project skill shadow a user skill of the same name, once", () => {
    // Claude Code resolves a name collision in the project's favour. Emitting both would
    // give two inventory items sharing an id: the token table double-counts them, and
    // applyProposals records the first proposal's freshly written value as the second
    // proposal's "previous".
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: The user copy");
    writeSkill(join(root, "project"), "pdf", "name: pdf\ndescription: The project copy");
    const items = scan();
    expect(items.map((i) => i.id)).toEqual(["pdf"]);
    expect(items[0].description).toBe("The project copy");
  });

  it("lets a plugin skill shadow a user skill of the same name, once", () => {
    writeSkill(join(root, "user"), "chart", "name: chart\ndescription: The user copy");
    writeSkill(join(root, "plugin"), "chart", "name: chart\ndescription: The plugin copy");
    const items = scan();
    expect(items.map((i) => i.id)).toEqual(["chart"]);
    expect(items[0].description).toBe("The plugin copy");
  });

  // --- real-machine directory shapes ----------------------------------------------

  it("finds a skill reached through a symlinked directory", () => {
    // `~/.claude/skills/hf-cli -> ../../.agents/skills/hf-cli` is a real shape on a live
    // machine. `Dirent.isDirectory()` is false for a symlink, so an isDirectory() gate
    // discards it entirely.
    writeSkill(join(root, "elsewhere"), "hf-cli", "name: hf-cli\ndescription: Hugging Face CLI");
    symlinkSync(join(root, "elsewhere", "hf-cli"), join(root, "user", "hf-cli"), "dir");
    expect(scan().map((i) => i.id)).toEqual(["hf-cli"]);
  });

  it("finds a skill nested two levels below the skills root", () => {
    // `~/.claude/skills/synced/<uuid>/<name>/SKILL.md` is the shape skill sync writes. A
    // flat scan looks for `skills/synced/SKILL.md`, misses, and discards the whole subtree.
    writeSkill(
      join(root, "user", "synced", "7f3c-uuid"),
      "mempalace",
      "name: mempalace\ndescription: Memory palace",
    );
    expect(scan().map((i) => i.id)).toEqual(["mempalace"]);
  });

  it("stops descending below the bounded depth", () => {
    writeSkill(join(root, "user", "a", "b", "c"), "too-deep", "name: too-deep\ndescription: Nope");
    expect(scan()).toHaveLength(0);
  });

  it("terminates on a symlink cycle instead of recursing forever", () => {
    // `user/nest/loop` points back at `user`, so an unguarded recursive walk never returns.
    mkdirSync(join(root, "user", "nest"), { recursive: true });
    symlinkSync(join(root, "user"), join(root, "user", "nest", "loop"), "dir");
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    expect(scan().map((i) => i.id)).toEqual(["pdf"]);
  });

  it("prefers a directory's own SKILL.md over recursing into it", () => {
    writeSkill(join(root, "user"), "pdf", "name: pdf\ndescription: PDFs");
    writeSkill(join(root, "user", "pdf"), "inner", "name: inner\ndescription: Should not appear");
    expect(scan().map((i) => i.id)).toEqual(["pdf"]);
  });
});
