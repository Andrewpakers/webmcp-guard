import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest project for the portal. Two things the root config cannot provide:
 *
 *  - the `@/*` path alias the app (and therefore the route handlers under test)
 *    imports with;
 *  - a setup file that points the SQLite layer at an in-memory database, so
 *    tests never touch `apps/portal/data/portal.db`.
 */
export default defineConfig({
  resolve: {
    alias: { "@": rootDir },
  },
  test: {
    name: "portal",
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
