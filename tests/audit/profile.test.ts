import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfile } from "../../src/audit/profile.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-profile-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("buildProfile", () => {
  it("reads the start of the README", () => {
    writeFileSync(join(root, "README.md"), "# proj\nA CLI tool.", "utf8");
    expect(buildProfile(root, []).readme).toContain("A CLI tool.");
  });

  it("caps the README at 2000 characters", () => {
    writeFileSync(join(root, "README.md"), "x".repeat(5000), "utf8");
    expect(buildProfile(root, []).readme).toHaveLength(2000);
  });

  it("includes manifests it recognises", () => {
    writeFileSync(join(root, "package.json"), '{"name":"proj"}', "utf8");
    expect(buildProfile(root, []).manifests.join()).toContain("package.json");
  });

  it("lists the top-level tree without dot directories", () => {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git"));
    const tree = buildProfile(root, []).tree;
    expect(tree).toContain("src/");
    expect(tree.join()).not.toContain(".git");
  });

  it("carries the prompts it is given", () => {
    expect(buildProfile(root, ["do a thing"]).prompts).toEqual(["do a thing"]);
  });

  it("works in an empty directory", () => {
    const profile = buildProfile(root, []);
    expect(profile.readme).toBe("");
    expect(profile.manifests).toEqual([]);
  });

  it("survives a README that is actually a directory", () => {
    mkdirSync(join(root, "README.md"), { recursive: true });
    expect(() => buildProfile(root, [])).not.toThrow();
    expect(buildProfile(root, []).readme).toBe("");
  });

  it("survives a manifest that is actually a directory", () => {
    mkdirSync(join(root, "package.json"), { recursive: true });
    expect(() => buildProfile(root, [])).not.toThrow();
    expect(buildProfile(root, []).manifests).toEqual([]);
  });

  it("returns defaults when the project root does not exist", () => {
    const missing = join(root, "does-not-exist");
    expect(() => buildProfile(missing, [])).not.toThrow();
    const profile = buildProfile(missing, []);
    expect(profile.readme).toBe("");
    expect(profile.manifests).toEqual([]);
    expect(profile.tree).toEqual([]);
  });
});
