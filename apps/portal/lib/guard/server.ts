import { createGuardServer, type GuardServer } from "@webmcp-guard/server";
import { sqliteStorage } from "@webmcp-guard/storage-sqlite";
import type BetterSqlite3 from "better-sqlite3";

import { getDb } from "@/lib/db/connection";

/**
 * The WebMCP Guard server, mounted **inside** the portal
 * (`docs/03-architecture.md`: the host app owns the data store and the guard's
 * route handlers live in it; the console is a stateless client of this API).
 *
 * ⚠️ Server-only, like everything under `lib/db/`: it adopts the portal's own
 * `better-sqlite3` connection so `guard_rules` / `guard_logs` / `guard_vault`
 * sit in the same file as `patients` (docs/05). Never import it from a client
 * component — the browser talks to `/api/guard` over HTTP instead.
 *
 * The singleton is memoised on `globalThis` for the same reason the database
 * connection is: Next re-evaluates server modules on every hot reload, and a
 * fresh guard server per edit would re-run migrations and lose the memoised
 * `ready()` promise.
 */

/** Env vars the guard server reads, and the obviously-unsafe value used without them. */
export const GUARD_DEV_DEFAULTS = {
  GUARD_ORG_SECRET: "dev-only-org-secret--do-not-deploy",
  GUARD_VAULT_KEY: "dev-only-vault-key--do-not-deploy",
  GUARD_ADMIN_TOKEN: "dev-only-admin-token--do-not-deploy",
} as const;

export interface GuardSecrets {
  orgSecret: string;
  vaultKey: string;
  adminToken: string;
  /** Exact origin allowed to call the admin routes cross-origin (the console). */
  consoleOrigin?: string;
  /** Names of the env vars that were missing, in declaration order. */
  fellBack: string[];
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: keyof typeof GUARD_DEV_DEFAULTS, fellBack: string[]): string {
  const value = env[name];
  if (typeof value === "string" && value.trim().length > 0) return value;
  fellBack.push(name);
  return GUARD_DEV_DEFAULTS[name];
}

/**
 * Resolves the guard's secrets from the environment, substituting a
 * deterministic dev value for anything missing.
 *
 * Falling back rather than throwing is a deliberate demo-quickstart decision:
 * `git clone && pnpm install && pnpm dev` has to produce a working guarded
 * portal with zero setup, and a judge who never opens `.env.example` still sees
 * the product. The defaults are named so that they can only ever be read as
 * broken in production, the fallback is announced on the server console, and
 * the README documents it. Nothing secret is committed — these *are* the
 * committed values, and they protect nothing.
 */
export function resolveGuardSecrets(env: Env = process.env): GuardSecrets {
  const fellBack: string[] = [];
  const secrets: GuardSecrets = {
    orgSecret: read(env, "GUARD_ORG_SECRET", fellBack),
    vaultKey: read(env, "GUARD_VAULT_KEY", fellBack),
    adminToken: read(env, "GUARD_ADMIN_TOKEN", fellBack),
    fellBack,
  };

  const consoleOrigin = env.GUARD_CONSOLE_ORIGIN?.trim();
  if (consoleOrigin) secrets.consoleOrigin = consoleOrigin;
  return secrets;
}

/** The one-paragraph warning printed when any secret fell back. */
export function insecureDefaultsWarning(fellBack: readonly string[]): string {
  return (
    `[WebMCP Guard] Using insecure development defaults for: ${fellBack.join(", ")}. ` +
    "Anyone who can reach this deployment can read its audit log and edit its policy. " +
    "Copy .env.example to apps/portal/.env.local and set real values before deploying."
  );
}

const GLOBAL_KEY = Symbol.for("lakeside.portal.guard-server");

interface CachedGuard {
  server: GuardServer;
  /** The connection the storage adapter adopted, so a reopened db rebuilds it. */
  database: BetterSqlite3.Database;
}

interface GuardGlobal {
  [GLOBAL_KEY]?: CachedGuard;
}

let hasWarnedInsecure = false;

/** Test seam: lets a test observe the once-only warning more than once. */
export function resetGuardServerWarning(): void {
  hasWarnedInsecure = false;
}

/**
 * The process-wide guard server. Built on first use against the portal's live
 * database connection; rebuilt if that connection is ever replaced (tests close
 * and reopen it, and `getDb()` reopens after a close).
 */
export function getGuardServer(): GuardServer {
  const store = globalThis as GuardGlobal;
  const database = getDb();

  const cached = store[GLOBAL_KEY];
  if (cached && cached.database === database) return cached.server;

  const secrets = resolveGuardSecrets();
  if (secrets.fellBack.length > 0 && !hasWarnedInsecure) {
    hasWarnedInsecure = true;
    console.warn(insecureDefaultsWarning(secrets.fellBack));
  }

  const server = createGuardServer({
    // Adoption mode: the guard's tables live alongside the portal's own rather
    // than in a second file, and the adapter never closes a handle it did not
    // open (docs/05: "WebMCP Guard's tables live alongside it").
    storage: sqliteStorage({ database }),
    orgSecret: secrets.orgSecret,
    vaultKey: secrets.vaultKey,
    adminToken: secrets.adminToken,
    ...(secrets.consoleOrigin !== undefined ? { consoleOrigin: secrets.consoleOrigin } : {}),
  });

  store[GLOBAL_KEY] = { server, database };
  return server;
}

/** Test helper: drops the memoised server so the next call rebuilds it. */
export function resetGuardServer(): void {
  const store = globalThis as GuardGlobal;
  delete store[GLOBAL_KEY];
}
