import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/token-saver.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@earendil-works/*", "typebox"],
});
console.log("wrote packages/pi/dist/token-saver.js");
