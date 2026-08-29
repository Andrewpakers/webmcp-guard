import type BetterSqlite3 from "better-sqlite3";

import { openDatabase } from "./connection";

/**
 * Test-only helper: an isolated, fully seeded in-memory portal database.
 *
 * Not imported by any runtime code path — it exists so the repository tests can
 * exercise real SQL (including the cascade deletes and the collations) without
 * touching `apps/portal/data/portal.db`.
 */
export function createTestDb(): BetterSqlite3.Database {
  return openDatabase(":memory:");
}
