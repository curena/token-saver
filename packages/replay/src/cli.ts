#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@token-saver/core";
import type { JevClient, JevRequest } from "@token-saver/core";
import { cachingClient } from "./jevCache.js";
import { replaySession } from "./run.js";
import { renderReport, summarize } from "./report.js";
import type { TauRun } from "./report.js";

// Anthropic-shaped defaults, per token.
const DEFAULT_PRICES = { input: 3 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function httpClient(): JevClient {
  const key = process.env.TYPESAFE_API_KEY;
  return {
    async systemOne(request: JevRequest) {
      if (key === undefined) throw new Error("TYPESAFE_API_KEY is not set");
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`typesafe ${response.status}`);
      return (await response.json()) as { answers: Record<string, { noul: number }> };
    },
  };
}

function sessionFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(target, name));
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const targets = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && !arg.match(/^[\d.,/]+$/));
const outDir = flag("report", "out");
const taus = flag("tau", "0.3").split(",").map(Number);

mkdirSync(outDir, { recursive: true });
const client = cachingClient(httpClient(), join(outDir, "jev-cache.json"));
const files = targets.flatMap(sessionFiles);
const runs: TauRun[] = [];

for (const tau of taus) {
  const metrics = [];
  for (const file of files) {
    metrics.push(
      await replaySession(
        readFileSync(file, "utf8"),
        file,
        client,
        { ...DEFAULT_CONFIG, keepThreshold: tau },
        DEFAULT_PRICES,
      ),
    );
  }
  runs.push({ tau, metrics });
  const summary = summarize(metrics);
  console.log(
    `tau ${tau}: saved ${summary.savedPct.toFixed(1)}%, ${summary.misses} misses, ` +
    `net $${summary.netUsd.toFixed(4)} (jev $${summary.jevUsd.toFixed(4)})`,
  );
}

writeFileSync(join(outDir, "report.md"), renderReport(runs));
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(runs, null, 2));
console.log(`\nwrote ${join(outDir, "report.md")}`);
