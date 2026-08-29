import { defineConfig } from "vitest/config";

/**
 * Single entry point for the whole workspace: `pnpm test` at the root runs the
 * tests of every package and app in one pass. Each directory becomes a Vitest
 * "project" named after its package.json `name`.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
