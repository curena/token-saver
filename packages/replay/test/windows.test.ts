import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelWindows } from "../src/windows.js";

describe("loadModelWindows", () => {
  it("maps model ids to context windows from a pi models store", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ts-models-")), "models-store.json");
    writeFileSync(path, JSON.stringify({
      openrouter: { models: [{ id: "~deepseek/deepseek-pro-latest", contextWindow: 163840 }, { id: "nowin" }] },
    }));
    const windows = loadModelWindows(path);
    expect(windows.get("~deepseek/deepseek-pro-latest")).toBe(163840);
    expect(windows.has("nowin")).toBe(false);
  });

  it("returns an empty map for a missing file", () => {
    expect(loadModelWindows("/nonexistent/models.json").size).toBe(0);
  });
});
