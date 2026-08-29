import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import { seedIfEmpty } from "./seed";

/**
 * Server-only SQLite connection for the portal's own patient data.
 *
 * ⚠️ Never import this module (or anything under `lib/db/`) from a client
 * component — `better-sqlite3` is a native Node addon and cannot be bundled for
 * the browser. Client code reaches the data through `app/api/portal/*` instead.
 *
 * The connection is memoised on `globalThis` because Next.js re-evaluates server
 * modules on every hot reload in dev; without the singleton each edit would open
 * (and leak) another handle to the same file.
 */

const GLOBAL_KEY = Symbol.for("lakeside.portal.db");

interface DbGlobal {
  [GLOBAL_KEY]?: BetterSqlite3.Database;
}

/**
 * Where the demo database lives. `apps/portal/data/` is gitignored, so a clean
 * clone boots into a freshly seeded database (docs/03: seed-on-boot on Render,
 * whose free-tier disk is ephemeral). `PORTAL_DB_PATH` overrides it — tests use
 * `:memory:`, a deployment can point at a mounted disk.
 */
export function resolveDatabasePath(): string {
  const configured = process.env.PORTAL_DB_PATH;
  if (configured && configured.trim().length > 0) {
    return configured === ":memory:" ? configured : resolve(configured);
  }
  return join(process.cwd(), "data", "portal.db");
}

/** Opens a connection, applies pragmas, creates the schema and seeds if empty. */
export function openDatabase(path: string): BetterSqlite3.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  // WAL keeps readers from blocking the writer — the portal reads on every page
  // render while tools write in the background.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // Required for the ON DELETE CASCADE that cleans up notes and appointments.
  db.pragma("foreign_keys = ON");

  seedIfEmpty(db);
  return db;
}

/** The process-wide connection. Seeds on first use, then reuses the handle. */
export function getDb(): BetterSqlite3.Database {
  const store = globalThis as DbGlobal;
  const existing = store[GLOBAL_KEY];
  if (existing && existing.open) return existing;

  const db = openDatabase(resolveDatabasePath());
  store[GLOBAL_KEY] = db;
  return db;
}

/** Test helper: drops the memoised handle so the next `getDb()` reopens. */
export function closeDb(): void {
  const store = globalThis as DbGlobal;
  const existing = store[GLOBAL_KEY];
  if (existing?.open) existing.close();
  delete store[GLOBAL_KEY];
}
