import { readFileSync } from "node:fs";

/** Model id -> context window, from pi's models-store.json (any nesting). */
export function loadModelWindows(path: string): Map<string, number> {
  const windows = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return windows;
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const model = node as { id?: unknown; contextWindow?: unknown };
    if (typeof model.id === "string" && typeof model.contextWindow === "number" && model.contextWindow > 0) {
      windows.set(model.id, model.contextWindow);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(parsed);
  return windows;
}
