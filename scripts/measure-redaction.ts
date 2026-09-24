/**
 * One-off measurement tool for Task 7's redaction requirement (not part of the test suite,
 * not run in CI). Run with:
 *
 *   npx tsx scripts/measure-redaction.ts <projectRoot> <transcriptDir>
 *
 * It calls the real `buildProfile` / `recentPrompts` exports — the same functions the
 * runtime uses before anything is sent to Jev — and reports how much of their *actual
 * output* contains a `[REDACTED]` hole, with before/after examples pulled by re-reading
 * the same source files this run touched. See task-7-report.md for the numbers this
 * produced against this repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProfile } from "../src/audit/profile.js";
import { recentPrompts } from "../src/audit/usage.js";
import { RECENT_USE_DAYS } from "../src/core/policy.js";

const root = process.argv[2];
const transcriptDir = process.argv[3];

if (!root || !transcriptDir) {
  console.error("usage: npx tsx scripts/measure-redaction.ts <projectRoot> <transcriptDir>");
  process.exit(1);
}

const README_LIMIT = 2000;
const MANIFEST_LIMIT = 1500;
const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
];

function rawReadme(): string {
  const path = ["README.md", "readme.md", "README"]
    .map((name) => join(root, name))
    .find((p) => existsSync(p));
  return path ? readFileSync(path, "utf8").slice(0, README_LIMIT) : "";
}

function rawManifests(): string[] {
  return MANIFESTS.filter((name) => existsSync(join(root, name))).map(
    (name) => `${name}: ${readFileSync(join(root, name), "utf8").slice(0, MANIFEST_LIMIT)}`,
  );
}

function countHoles(text: string): number {
  return (text.match(/\[REDACTED\]/g) ?? []).length;
}

/** Find the raw substring standing where a [REDACTED] hole appears in the redacted text. */
function findReplacedSpans(before: string, after: string): string[] {
  const spans: string[] = [];
  let bi = 0;
  let ai = 0;
  while (bi < before.length && ai < after.length) {
    if (before[bi] === after[ai]) {
      bi++;
      ai++;
      continue;
    }
    const holeStart = bi;
    const idx = after.indexOf("[REDACTED]", ai);
    if (idx === -1) break;
    ai = idx + "[REDACTED]".length;
    const resyncChar = after.slice(ai, ai + 12);
    const found = resyncChar ? before.indexOf(resyncChar, bi) : -1;
    const holeEnd = found === -1 ? before.length : found;
    spans.push(before.slice(holeStart, holeEnd));
    bi = holeEnd;
  }
  return spans;
}

console.log(`=== Measuring against root=${root} transcriptDir=${transcriptDir} ===\n`);

// The real pipeline output — this is what actually gets sent to Jev, including the same
// 30-day window the audit applies.
const since = new Date(Date.now() - RECENT_USE_DAYS * 86_400_000);
const prompts = recentPrompts(transcriptDir, 20, since);
const profile = buildProfile(root, prompts);

const rawReadmeText = rawReadme();
const readmeHoles = countHoles(profile.readme);
console.log(`README: ${rawReadmeText.length} raw chars, ${readmeHoles} redaction hole(s) in buildProfile's actual output`);
if (readmeHoles > 0) {
  console.log("  spans replaced:", findReplacedSpans(rawReadmeText, profile.readme));
}

const rawManifestTexts = rawManifests();
let manifestHoles = 0;
profile.manifests.forEach((redacted, i) => {
  const raw = rawManifestTexts[i] ?? "";
  const holes = countHoles(redacted);
  manifestHoles += holes;
  console.log(`Manifest[${i}] (${raw.slice(0, 30)}...): ${holes} redaction hole(s)`);
  if (holes > 0) console.log("  spans replaced:", findReplacedSpans(raw, redacted));
});

console.log(`\nTree: ${profile.tree.length} entries (already denylist-filtered, never redacted — see task-7-report.md)`);

const promptHoles = prompts.filter((p) => p.includes("[REDACTED]"));
console.log(`\nPrompts sampled: ${prompts.length}; prompts containing a redaction hole: ${promptHoles.length}`);
promptHoles.forEach((p, i) => console.log(`  [${i}] ${p.slice(0, 200)}`));

console.log(`\n=== TOTAL redaction holes in the actual buildProfile output (readme+manifests): ${readmeHoles + manifestHoles} ===`);
