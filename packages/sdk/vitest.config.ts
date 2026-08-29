import { defineConfig } from "vitest/config";

/**
 * Vitest project for the SDK.
 *
 * The root config discovers this directory through its `projects` glob; naming
 * the project here keeps that name identical to the package name while also
 * letting `pnpm --filter @webmcp-guard/sdk test` run the suite on its own
 * (a bare `vitest run` inside the package otherwise resolves the workspace
 * root config and finds no projects).
 *
 * Environment is `node` on purpose: jsdom has no WebMCP either, so these tests
 * stub `document` / `navigator` on `globalThis` instead (see `test-support.ts`).
 */
export default defineConfig({
  test: {
    name: "@webmcp-guard/sdk",
    environment: "node",
  },
});
