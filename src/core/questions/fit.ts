import { score } from "@typesafe-ai/sdk";
import { redact } from "../redact.js";
import type { FitLevel, InventoryItem, ProjectProfile } from "../types.js";

export const FIT_BATCH_SIZE = 20;

/**
 * Level descriptions in rubric order, each self-contained.
 *
 * The SDK's `score()` builder indexes criteria by rubric position starting at zero (it
 * rejects a name-keyed map), so this is a tuple rather than the named record the fit levels
 * would otherwise suggest. Index 0 is the best fit ("core") through index 3 ("irrelevant"),
 * which is why `levelForIndex` below adds one to recover the 1-4 `FitLevel`.
 */
const CRITERIA = [
  "The work described in this project regularly needs exactly what this item does; a " +
    "developer working here would reach for it in a normal week.",
  "This project's work touches what this item does now and then, for example a related " +
    "file format, service or workflow that appears occasionally rather than routinely.",
  "The item is a general-purpose capability with no particular connection to this " +
    "project's subject matter, though it could apply to almost any project.",
  "Nothing in this project's code, dependencies or recent requests relates to what this " +
    "item does; using it here would be surprising.",
] as const;

/**
 * Round a rubric score (0-3, possibly fractional) to the FitLevel it falls closest to (1-4).
 * Exact ties (0.5, 1.5, 2.5) round up, i.e. toward the worse fit — deliberate, not just
 * `Math.round`'s default behavior; keep it this way rather than "fixing" it later.
 */
function levelForIndex(index: number): FitLevel {
  const clamped = Math.min(3, Math.max(0, Math.round(index)));
  return (clamped + 1) as FitLevel;
}

export function fitState(profile: ProjectProfile): Record<string, unknown> {
  return {
    project_root: profile.root,
    readme: profile.readme,
    manifests: profile.manifests,
    file_tree: profile.tree,
    recent_requests: profile.prompts,
  };
}

/**
 * `Jev.ask` redacts `state`, but it does not redact `questions` -- so anything interpolated
 * into question text must be redacted here, at the call site. `name` and `description` come
 * verbatim from a SKILL.md on disk, which is exactly the kind of file that ends up holding
 * a deploy key someone pasted into an example.
 *
 * Deliberately NOT done by running `redactDeep` over the built `questions` object: that
 * rebuilds the SDK's own question objects through `Object.fromEntries(Object.entries(...))`.
 * It happens to work today, but it couples redaction to an SDK internal -- if `score()` ever
 * returns a branded class or carries a non-enumerable field, redaction would quietly corrupt
 * requests, and fail-open would report that as "Jev is down" rather than as a bug here.
 */
export function fitQuestions(items: InventoryItem[]): Record<string, ReturnType<typeof score>> {
  const questions: Record<string, ReturnType<typeof score>> = {};
  for (const item of items) {
    questions[`fit::${item.id}`] = score(
      `An agent working in this project can load a capability called '${redact(item.name)}', ` +
        `described as: ${redact(item.description)}. How well does it fit the work this project ` +
        `involves, judging from \`readme\`, \`manifests\`, \`file_tree\` and ` +
        "`recent_requests`?",
      CRITERIA,
    );
  }
  return questions;
}

export function parseFit(
  answers: Record<string, { score?: number; confidence?: number }>,
): Map<string, FitLevel> {
  const levels = new Map<string, FitLevel>();
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith("fit::")) continue;
    if (typeof answer.score !== "number" || Number.isNaN(answer.score)) continue;
    levels.set(key.slice("fit::".length), levelForIndex(answer.score));
  }
  return levels;
}
