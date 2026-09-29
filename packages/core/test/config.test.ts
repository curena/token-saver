import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

const createdDirs: string[] = [];

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "token-saver-"));
  createdDirs.push(dir);
  const path = join(dir, "token-saver.json");
  writeFileSync(path, contents);
  return path;
}

function fileWith(contents: unknown): string {
  return tempFile(JSON.stringify(contents));
}

function fileWithRaw(contents: string): string {
  return tempFile(contents);
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("returns the defaults with no files or env", () => {
    expect(loadConfig({ files: [], env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("applies files in order, later files winning", () => {
    const config = loadConfig({
      files: [fileWith({ keepThreshold: 0.5 }), fileWith({ keepThreshold: 0.4, protectTurns: 5 })],
      env: {},
    });
    expect(config.keepThreshold).toBe(0.4);
    expect(config.protectTurns).toBe(5);
  });

  it("lets env override files", () => {
    const config = loadConfig({
      files: [fileWith({ keepThreshold: 0.5 })],
      env: { TOKEN_SAVER_KEEP_THRESHOLD: "0.2" },
    });
    expect(config.keepThreshold).toBe(0.2);
  });

  it("treats TOKEN_SAVER=off as disabled", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER: "off" } }).enabled).toBe(false);
    expect(loadConfig({ files: [], env: { TOKEN_SAVER: "on" } }).enabled).toBe(true);
  });

  it("ignores missing files and unknown keys", () => {
    const config = loadConfig({
      files: ["/nope/token-saver.json", fileWith({ nonsense: 1, jevModel: "jev-1.13.0" })],
      env: { TOKEN_SAVER_NONSENSE: "1" },
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("ignores a malformed config file", () => {
    expect(loadConfig({ files: [fileWithRaw("not json {")], env: {} })).toEqual(DEFAULT_CONFIG);
  });

  it("ignores non-numeric env values for numeric settings", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_PROTECT_TURNS: "soon" } }).protectTurns).toBe(2);
  });

  it("ignores empty-string env values for numeric settings", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_PROTECT_TURNS: "" } }).protectTurns).toBe(2);
  });

  it("reads excludedTools as a comma-separated env list", () => {
    const config = loadConfig({ files: [], env: { TOKEN_SAVER_EXCLUDED_TOOLS: "edit,write,apply_patch" } });
    expect(config.excludedTools).toEqual(["edit", "write", "apply_patch"]);
  });

  it("ignores empty-string excludedTools", () => {
    expect(loadConfig({ files: [], env: { TOKEN_SAVER_EXCLUDED_TOOLS: "" } }).excludedTools).toEqual(["edit", "write"]);
  });

  it("does not alias the default excludedTools array", () => {
    const config = loadConfig({ files: [], env: {} });
    config.excludedTools.push("apply_patch");
    expect(DEFAULT_CONFIG.excludedTools).toEqual(["edit", "write"]);
  });

  it("defaults the water levels", () => {
    const config = loadConfig({ env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.lowWater).toBe(0.3);
    expect(config.contextLevel).toBe(0.85);
  });

  it("reads water levels from files and env", () => {
    const config = loadConfig({
      files: [fileWith({ highWater: 0.6, lowWater: 0.2 })],
      env: { TOKEN_SAVER_LOW_WATER: "0.25" },
    });
    expect(config.highWater).toBe(0.6);
    expect(config.lowWater).toBe(0.25);
  });

  it("falls back to default levels when lowWater is not below highWater", () => {
    const config = loadConfig({ files: [fileWith({ highWater: 0.3, lowWater: 0.5 })], env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.lowWater).toBe(0.3);
    expect(config.contextLevel).toBe(0.85);
  });

  it("falls back to default levels when highWater exceeds contextLevel", () => {
    const config = loadConfig({ files: [fileWith({ highWater: 0.9, contextLevel: 0.8 })], env: {} });
    expect(config.highWater).toBe(0.75);
    expect(config.contextLevel).toBe(0.85);
  });
});
