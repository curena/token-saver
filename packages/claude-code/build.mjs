import { chmodSync } from "node:fs";
import { build } from "esbuild";

// Bundled rather than tsc-compiled, the same way the pi extension ships. The
// workspace packages resolve to raw .ts through their `main`, so a plain `tsc`
// emit would leave `@token-saver/audit` imports that Node cannot resolve at
// runtime. `@typesafe-ai/sdk` stays external: the CLI imports it dynamically so
// that a missing key -- or a missing SDK -- costs nothing on the no-key path.
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/token-saver.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // No shebang banner: src/cli.ts already carries one and esbuild preserves it, so adding
  // a banner puts a second `#!` on line 2, which is a syntax error rather than a comment.
  external: ["@typesafe-ai/sdk"],
});
chmodSync("dist/token-saver.js", 0o755);
console.log("wrote packages/claude-code/dist/token-saver.js");
