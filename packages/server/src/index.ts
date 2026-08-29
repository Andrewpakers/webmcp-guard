/**
 * `@webmcp-guard/server` — the Node half of WebMCP Guard and the enforcement
 * point.
 *
 * Owns policy resolution, the classification/tokenization pipeline, the token
 * vault, the audit log writer, and the HTTP route handlers mounted inside the
 * host app (`/gate`, `/transform`, `/policies`, `/logs`, `/stats`,
 * `/tokens/reveal`).
 *
 * Implemented in Phase 2 (see `docs/07-development-plan.md`). This module is a
 * placeholder so the package, its tsconfig, and the test runner are wired up.
 */
export const PACKAGE_NAME = "@webmcp-guard/server" as const;
