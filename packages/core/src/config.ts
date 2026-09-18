import type { Config } from "./types.js";
import { readFileSync } from "node:fs";

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  minResultTokens: 1500,
  protectTurns: 2,
  keepThreshold: 0.3,
  leaveAloneRatio: 0.7,
  minSaving: 500,
  costMargin: 1.5,
  contextLevel: 0.6,
  expectedSaveRatio: 0.5,
  jevBudgetMs: 1500,
  jevModel: "jev-1.13.0",
  excludedTools: ["edit", "write"],
};

const NUMERIC_KEYS = [
  "minResultTokens", "protectTurns", "keepThreshold", "leaveAloneRatio",
  "minSaving", "costMargin", "contextLevel", "expectedSaveRatio", "jevBudgetMs",
] as const;

function envName(key: string): string {
  return `TOKEN_SAVER_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export function loadConfig(
  options: { files?: string[]; env?: NodeJS.ProcessEnv } = {},
): Config {
  const env = options.env ?? process.env;
  const config: Config = { ...DEFAULT_CONFIG, excludedTools: [...DEFAULT_CONFIG.excludedTools] };

  for (const file of options.files ?? []) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // missing or malformed config must never break a session
    }
    for (const key of NUMERIC_KEYS) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value)) config[key] = value;
    }
    if (typeof parsed.jevModel === "string") config.jevModel = parsed.jevModel;
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled;
    if (Array.isArray(parsed.excludedTools)) {
      config.excludedTools = parsed.excludedTools.filter((t): t is string => typeof t === "string");
    }
  }

  for (const key of NUMERIC_KEYS) {
    const raw = env[envName(key)];
    if (raw === undefined) continue;
    if (raw.trim() === "") continue; // an empty env value is "not set", never coerced to 0
    const value = Number(raw);
    if (Number.isFinite(value)) config[key] = value;
  }
  const model = env.TOKEN_SAVER_JEV_MODEL;
  if (model !== undefined && model.length > 0) config.jevModel = model;
  const tools = env.TOKEN_SAVER_EXCLUDED_TOOLS;
  if (tools !== undefined && tools.trim() !== "") {
    config.excludedTools = tools.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (env.TOKEN_SAVER === "off") config.enabled = false;

  return config;
}
