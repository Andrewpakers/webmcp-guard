/**
 * `@webmcp-guard/sdk` — the browser half of WebMCP Guard.
 *
 * Wraps `document.modelContext.registerTool` so a site's WebMCP tools run
 * through the guard pipeline (gate -> execute -> transform) before an agent
 * ever sees their results.
 *
 * Implemented in Phase 2 (see `docs/07-development-plan.md`). This module is a
 * placeholder so the package, its tsconfig, and the test runner are wired up.
 */
export const PACKAGE_NAME = "@webmcp-guard/sdk" as const;
