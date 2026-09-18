import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDenylistedPath, redact } from "../core/redact.js";
import type { ProjectProfile } from "../core/types.js";

const README_LIMIT = 2000;
const MANIFEST_LIMIT = 1500;
/** Top-level tree entries kept before truncating with a "… N more" marker. */
const TREE_LIMIT = 200;
const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
];

/** Read a text file, degrading to null on any failure: missing, permissions, or a directory. */
function tryRead(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function buildProfile(root: string, prompts: string[]): ProjectProfile {
  const readmePath = ["README.md", "readme.md", "README"]
    .map((name) => join(root, name))
    .find((path) => existsSync(path));
  const readme = redact((readmePath && tryRead(readmePath)?.slice(0, README_LIMIT)) ?? "");

  const manifests: string[] = [];
  for (const name of MANIFESTS) {
    const contents = tryRead(join(root, name));
    if (contents !== null) {
      manifests.push(redact(`${name}: ${contents.slice(0, MANIFEST_LIMIT)}`));
    }
  }

  let tree: string[] = [];
  if (existsSync(root)) {
    try {
      tree = readdirSync(root, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .filter((entry) => {
          // A directory needs the trailing slash for the denylist's `secrets/` pattern to
          // match; a bare `join(root, "secrets")` (no trailing slash) would not.
          const path = join(root, entry.name) + (entry.isDirectory() ? "/" : "");
          return !isDenylistedPath(path);
        })
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
    } catch {
      // Permissions, or `root` turned out not to be a directory after all.
      tree = [];
    }
  }
  if (tree.length > TREE_LIMIT) {
    const hidden = tree.length - TREE_LIMIT;
    tree = [...tree.slice(0, TREE_LIMIT), `… ${hidden} more`];
  }

  return { root, readme, manifests, tree, prompts };
}
