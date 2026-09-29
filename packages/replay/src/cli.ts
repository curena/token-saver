#!/usr/bin/env node
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@token-saver/prune";
import type { JevClient, JevRequest } from "@token-saver/prune";
import { parseArgs } from "./args.js";
import { readSessionFiles } from "./files.js";
import { cachingClient } from "./jevCache.js";
import { replaySession } from "./run.js";
import { loadModelWindows } from "./windows.js";
import { renderReport, summarize } from "./report.js";
import type { TauRun } from "./report.js";

function httpClient(): JevClient {
  const key = process.env.TYPESAFE_API_KEY;
  return {
    async systemOne(request: JevRequest, signal?: AbortSignal) {
      if (key === undefined) throw new Error("TYPESAFE_API_KEY is not set");
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
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

const { targets, tau: taus, report: outDir, window, reserve, models } = parseArgs(process.argv.slice(2));

mkdirSync(outDir, { recursive: true });
const client = cachingClient(httpClient(), join(outDir, "jev-cache.json"));
const files = targets.flatMap(sessionFiles);
// Snapshot the files once: every tau run must see identical input, otherwise a
// session that grows mid-run (a live one being appended to) skews later taus.
const sessions = readSessionFiles(files);
const runs: TauRun[] = [];

const modelWindows = loadModelWindows(models ?? join(homedir(), ".pi", "agent", "models-store.json"));
function windowFor(text: string): number | null {
  if (window !== null) return window;
  const match = /"model":"([^"]+)"/.exec(text);
  return match === null ? null : modelWindows.get(match[1]!) ?? null;
}

for (const tau of taus) {
  const metrics = [];
  for (const session of sessions) {
    metrics.push(
      await replaySession(
        session.text,
        session.file,
        client,
        { ...DEFAULT_CONFIG, keepThreshold: tau },
        { window: windowFor(session.text), reserveTokens: reserve },
      ),
    );
  }
  runs.push({ tau, metrics });
  const summary = summarize(metrics);
  console.log(
    `tau ${tau}: peak ${Math.round(summary.peakBefore)} -> ${Math.round(summary.peakAfter)}, ` +
    `mean ${Math.round(summary.meanBefore)} -> ${Math.round(summary.meanAfter)}, ` +
    `${summary.sweeps} sweeps, ${Math.round(summary.reprocessedTokens)} re-processed, ` +
    `compactions ${summary.compactionsBefore} -> ${summary.compactionsAfter}, ${summary.misses} misses` +
    (summary.skippedSessions > 0 ? ` (${summary.skippedSessions} skipped: no window)` : ""),
  );
}

writeFileSync(join(outDir, "report.md"), renderReport(runs));
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(runs, null, 2));
console.log(`\nwrote ${join(outDir, "report.md")}`);
