/**
 * `@webmcp-guard/storage-sqlite` — SQLite (better-sqlite3) `GuardStorage`
 * implementation used by the demo portal.
 *
 * WAL mode, plain-SQL migrations, idempotent init so the portal can seed on
 * boot. The `better-sqlite3` dependency is added in Phase 2 together with the
 * implementation (see `docs/07-development-plan.md`); this module is a
 * placeholder so the package, its tsconfig, and the test runner are wired up.
 */
export const PACKAGE_NAME = "@webmcp-guard/storage-sqlite" as const;
