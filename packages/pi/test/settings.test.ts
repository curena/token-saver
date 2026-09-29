import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReserveTokens } from "../src/settings.js";

const dirs: string[] = [];
function file(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("readReserveTokens", () => {
  it("defaults to pi's 16384", () => {
    expect(readReserveTokens([])).toBe(16384);
    expect(readReserveTokens(["/nonexistent/settings.json"])).toBe(16384);
  });

  it("reads compaction.reserveTokens, later files winning", () => {
    const global = file(JSON.stringify({ compaction: { reserveTokens: 20000 } }));
    const project = file(JSON.stringify({ compaction: { reserveTokens: 8000 } }));
    expect(readReserveTokens([global])).toBe(20000);
    expect(readReserveTokens([global, project])).toBe(8000);
  });

  it("ignores malformed files and bad values", () => {
    expect(readReserveTokens([file("{nope"), file(JSON.stringify({ compaction: { reserveTokens: -5 } }))])).toBe(16384);
  });
});
