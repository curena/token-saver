import { createHash } from "node:crypto";
import type { InventoryItem, ProjectProfile } from "../core/types.js";

/**
 * Detects setup drift: the installed items plus the project's stable description.
 * Prompts are excluded on purpose, since they change every session.
 */
export function fingerprint(profile: ProjectProfile, items: InventoryItem[]): string {
  const payload = JSON.stringify({
    readme: profile.readme,
    manifests: profile.manifests,
    tree: profile.tree,
    items: items.map((i) => [i.id, i.kind, i.description]).sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
