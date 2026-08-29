import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest project for the console.
 *
 * Two things the root config cannot provide: the `@/*` path alias the app
 * imports with, and the project name `pnpm --filter console test` filters on.
 *
 * Environment is `node`, not jsdom: the console deliberately keeps its logic in
 * pure modules under `lib/` (API envelope handling, filter → query string, rule
 * form ⇄ `Rule` JSON, stats → chart series, payload masking) and its components
 * thin on top of them, so the suite never needs a DOM.
 */
export default defineConfig({
  resolve: {
    alias: { "@": rootDir },
  },
  test: {
    name: "console",
    environment: "node",
  },
});
