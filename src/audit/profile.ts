import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectProfile } from "../core/types.js";

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
  const readme = (readmePath && tryRead(readmePath)?.slice(0, README_LIMIT)) ?? "";

  const manifests: string[] = [];
  for (const name of MANIFESTS) {
    const contents = tryRead(join(root, name));
    if (contents !== null) manifests.push(`${name}: ${contents.slice(0, MANIFEST_LIMIT)}`);
  }

  let tree: string[] = [];
  if (existsSync(root)) {
    try {
      tree = readdirSync(root, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
    } catch {
      // Permissions, or `root` turned out not to be a directory after all.
      tree = [];
    }
  }

  return { root, readme, manifests, tree, prompts };
}
