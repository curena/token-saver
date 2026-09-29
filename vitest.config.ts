import { defineConfig } from "vitest/config";

export default defineConfig({
  // Two products, two tree shapes: the audit's flat `tests/`, and the pruner's
  // per-package `packages/*/test/`. Both run under one `vitest run` until the
  // restructure gives them a common home.
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
