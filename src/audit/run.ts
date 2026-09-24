import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { proposeState } from "../core/policy.js";
import { FIT_BATCH_SIZE, fitQuestions, fitState, parseFit } from "../core/questions/fit.js";
import type { FitLevel, InventoryItem, ProjectProfile, Proposal } from "../core/types.js";
import type { Jev } from "../runtime/jev.js";
import type { Store } from "../runtime/store.js";

export async function judgeFit(
  jev: Jev,
  profile: ProjectProfile,
  items: InventoryItem[],
): Promise<Map<string, FitLevel>> {
  const state = fitState(profile);
  const fits = new Map<string, FitLevel>();
  for (let i = 0; i < items.length; i += FIT_BATCH_SIZE) {
    const batch = items.slice(i, i + FIT_BATCH_SIZE);
    const answers = await jev.ask(state, fitQuestions(batch));
    if (!answers) continue; // fail open: no judgment, no proposal
    for (const [id, level] of parseFit(answers)) fits.set(id, level);
  }
  return fits;
}

export function buildProposals(
  items: InventoryItem[],
  fits: Map<string, FitLevel>,
  uses: Map<string, number>,
): Proposal[] {
  return items
    .map((item) => proposeState(item, fits.get(item.id) ?? null, uses.get(item.id) ?? 0))
    .filter((proposal) => proposal.to !== proposal.from);
}

const FIT_LABEL: Record<FitLevel, string> = {
  1: "core",
  2: "occasional",
  3: "general",
  4: "irrelevant",
};

export function renderProposals(proposals: Proposal[]): string {
  if (proposals.length === 0) return "No changes proposed.";
  const header = ["skill", "fit", "uses", "change", "cost", "why"];
  const rows = proposals.map((p) => [
    p.name,
    p.fit ? FIT_LABEL[p.fit] : "-",
    String(p.uses),
    `${p.from} -> ${p.to}`,
    `${p.tokens} tokens`,
    p.reason,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  const saved = proposals.filter((p) => p.to !== "on").reduce((sum, p) => sum + p.tokens, 0);
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `Estimated saving: ${saved} tokens per session.`,
  ].join("\n");
}

/** True for a plain JSON object: excludes null, arrays and non-object JSON values. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `skillOverrides` off a settings file as a plain string map, tolerating anything a
 * hand-edited or half-written settings.json might contain: missing file, malformed JSON,
 * JSON that parses to a non-object (`[]`, `"x"`, `null`), or a `skillOverrides` value that
 * itself isn't an object. Any of those is treated as "no overrides yet" rather than thrown.
 */
function readOverrides(settings: Record<string, unknown>): Record<string, string> {
  const raw = settings.skillOverrides;
  return isPlainObject(raw) ? { ...(raw as Record<string, string>) } : {};
}

/**
 * A settings file exists but cannot be read back as a JSON object. Thrown rather than
 * swallowed: the alternative is rewriting the file from `{}` and silently destroying
 * `permissions`, `env`, `hooks` and everything else it held, with nothing recorded in the
 * audit log and so no path back through `--undo`.
 */
export class MalformedSettingsError extends Error {
  constructor(readonly path: string) {
    super(
      `token-saver: ${path} exists but is not a readable JSON object, so it cannot be ` +
        "updated without destroying whatever it holds. Fix or remove the file, then re-run.",
    );
    this.name = "MalformedSettingsError";
  }
}

/**
 * Read a settings file, distinguishing **absent** (fine: there are no settings yet, so `{}`)
 * from **unparseable** (not fine: there is content we cannot round-trip). Note this differs
 * deliberately from `readOverrides` below, which does fail open -- a junk `skillOverrides`
 * value inside an otherwise valid settings object is exactly what this tool repairs, and
 * rewriting it loses nothing else.
 */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MalformedSettingsError(path);
  }
  if (!isPlainObject(parsed)) throw new MalformedSettingsError(path);
  return parsed;
}

/**
 * Write settings atomically: a temp file in the same directory, then a rename over the
 * target. `writeFileSync` truncates before it writes, so a Ctrl-C or an ENOSPC partway
 * through leaves a truncated settings file; `rename` within one filesystem is atomic, so
 * the target is either the old content or the new one and never something in between.
 */
function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // Don't leave the temp file lying next to the user's settings on a failed write.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort only; the original error is the one that matters.
    }
    throw err;
  }
}

export function applyProposals(
  proposals: Proposal[],
  settingsPath: string,
  store: Store,
  now: Date,
): number {
  if (proposals.length === 0) return 0;
  const settings = readSettings(settingsPath);
  const overrides = readOverrides(settings);

  const previous: Record<string, string> = {};
  const applied: Record<string, string> = {};
  // `previous` must hold each id's value from before this apply began. Two proposals can
  // share an id, and by the second one `overrides[id]` already holds what the first wrote.
  // A `!hasOwnProperty(previous, id)` guard is not enough on its own: an id with no prior
  // override is deliberately absent from `previous`, so the second proposal would look
  // uncaptured and record the just-written value. Track what has been seen explicitly.
  const captured = new Set<string>();
  for (const proposal of proposals) {
    if (!captured.has(proposal.id)) {
      captured.add(proposal.id);
      if (Object.prototype.hasOwnProperty.call(overrides, proposal.id)) {
        previous[proposal.id] = overrides[proposal.id];
      }
    }
    overrides[proposal.id] = proposal.to;
    applied[proposal.id] = proposal.to;
  }

  // Append the audit entry BEFORE mutating settings. appendAudit can throw (e.g. a
  // non-string value in `previous`), and if that happens after the settings file is
  // rewritten, the user is left with changed settings and no undo record -- the exact
  // failure --undo exists to prevent. This order fails safe: if appendAudit throws, the
  // settings file is never touched, so there's nothing to undo in the first place.
  store.appendAudit({ at: now.toISOString(), file: settingsPath, previous, applied });

  settings.skillOverrides = overrides;
  writeSettings(settingsPath, settings);
  return proposals.length;
}

export function undoLast(store: Store, now: Date): string {
  const entry = store.lastAudit();
  if (!entry) return "Nothing to undo.";

  const settings = readSettings(entry.file);
  const overrides = readOverrides(settings);
  for (const id of Object.keys(entry.applied)) {
    if (Object.prototype.hasOwnProperty.call(entry.previous, id)) {
      overrides[id] = entry.previous[id];
    } else {
      delete overrides[id];
    }
  }
  settings.skillOverrides = overrides;
  writeSettings(entry.file, settings);

  // Record the revert AFTER the write, the opposite order from applyProposals, because the
  // two failure modes are not symmetric. applyProposals' undo is idempotent, so recording
  // first is safe there. This one is not: a revert record's `applied` is {}, so if the
  // write then fails, a retried --undo finds that record, iterates nothing, and reports
  // success while settings are still fully applied -- with no way left to revert at all.
  // Writing first means a failure here leaves settings reverted and the record missing, and
  // a retried --undo simply reverts the same entry again, which is a no-op. The write
  // itself is atomic (see writeSettings), so there is no partially-written state to record.
  store.appendAudit({ at: now.toISOString(), file: entry.file, previous: entry.applied, applied: {} });
  return `Reverted ${Object.keys(entry.applied).length} change(s) in ${entry.file}.`;
}
