import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  GuardStorageError,
  LogRecordSchema,
  POLICY_VERSION,
  RuleSchema,
  VaultEntrySchema,
  decodeLogCursor,
  encodeLogCursor,
  normalizeLogLimit,
  slugifyRuleId,
  type DayCount,
  type GuardStats,
  type GuardStorage,
  type LogCompletion,
  type LogPage,
  type LogQuery,
  type LogRecord,
  type PolicyDefaultAction,
  type PolicyDocument,
  type Rule,
  type RuleDraft,
  type RulePatch,
  type StatsRange,
  type ToolCount,
  type VaultEntry,
} from "@webmcp-guard/shared";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

/**
 * `@webmcp-guard/storage-sqlite` — the durable `GuardStorage` adapter used by
 * the demo portal (`docs/03-architecture.md`: the host app owns the database,
 * WebMCP Guard's tables live alongside the app's own).
 *
 * Everything is `IF NOT EXISTS`, so opening a store is the migration: the
 * portal can seed on boot against an ephemeral Render disk and get a working
 * database every time. `:memory:` is supported for tests.
 */
export const PACKAGE_NAME = "@webmcp-guard/storage-sqlite" as const;

/** Every table is prefixed so it can share a database with the host app's schema. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guard_rules (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL,
  priority    INTEGER NOT NULL,
  match_json  TEXT NOT NULL,
  action_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guard_rules_order ON guard_rules (priority, seq);

CREATE TABLE IF NOT EXISTS guard_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guard_logs (
  id                TEXT PRIMARY KEY,
  seq               INTEGER NOT NULL,
  status            TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  app               TEXT NOT NULL,
  tool              TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  agent_id          TEXT,
  agent_json        TEXT NOT NULL,
  session_json      TEXT,
  data_classes_json TEXT NOT NULL,
  rule_ids_json     TEXT NOT NULL,
  duration_ms       REAL NOT NULL,
  payloads_json     TEXT NOT NULL,
  justification     TEXT,
  message           TEXT
);

CREATE INDEX IF NOT EXISTS idx_guard_logs_recent ON guard_logs (timestamp DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_guard_logs_tool ON guard_logs (tool, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_guard_logs_verdict ON guard_logs (verdict, timestamp DESC);

CREATE TABLE IF NOT EXISTS guard_vault (
  token         TEXT PRIMARY KEY,
  data_class    TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  auth_tag      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
`;

const DEFAULT_ACTION_KEY = "default_action";
const PRIORITY_STEP = 10;

interface RuleRow {
  id: string;
  seq: number;
  name: string;
  enabled: number;
  priority: number;
  match_json: string;
  action_json: string;
}

interface LogRow {
  id: string;
  seq: number;
  status: string;
  timestamp: string;
  app: string;
  tool: string;
  verdict: string;
  agent_id: string | null;
  agent_json: string;
  session_json: string | null;
  data_classes_json: string;
  rule_ids_json: string;
  duration_ms: number;
  payloads_json: string;
  justification: string | null;
  message: string | null;
}

interface VaultRow {
  token: string;
  data_class: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  first_seen_at: string;
}

export interface SqliteStorageOptions {
  /**
   * Database file, or `":memory:"`. Parent directories are created. Ignored
   * when `database` is supplied.
   */
  path?: string;
  /**
   * An already-open connection to reuse — how the demo portal puts the guard
   * tables in the same file as its patient tables. The adapter never closes a
   * connection it did not open.
   */
  database?: BetterSqlite3.Database;
}

function openDatabase(options: SqliteStorageOptions): {
  db: BetterSqlite3.Database;
  owned: boolean;
} {
  if (options.database) return { db: options.database, owned: false };

  const path = options.path ?? ":memory:";
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // WAL keeps the console's log queries from blocking the gate's writes. It is
  // a no-op for `:memory:`, which is why it is safe to set unconditionally.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return { db, owned: true };
}

/** SQLite has no booleans; the column stores 0/1. */
function toBool(value: number): boolean {
  return value !== 0;
}

/** Rows carry `null` for absent values; the zod schemas want them gone. */
function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function rowToRule(row: RuleRow): Rule {
  return RuleSchema.parse({
    id: row.id,
    name: row.name,
    enabled: toBool(row.enabled),
    priority: row.priority,
    match: parseJson(row.match_json),
    action: parseJson(row.action_json),
  });
}

function rowToLog(row: LogRow): LogRecord {
  return LogRecordSchema.parse({
    id: row.id,
    status: row.status,
    timestamp: row.timestamp,
    app: row.app,
    tool: row.tool,
    verdict: row.verdict,
    agent: parseJson(row.agent_json),
    session: row.session_json === null ? undefined : parseJson(row.session_json),
    dataClasses: parseJson(row.data_classes_json),
    ruleIds: parseJson(row.rule_ids_json),
    durationMs: row.duration_ms,
    payloads: parseJson(row.payloads_json),
    justification: nullToUndefined(row.justification),
    message: nullToUndefined(row.message),
  });
}

function rowToVaultEntry(row: VaultRow): VaultEntry {
  return VaultEntrySchema.parse({
    token: row.token,
    dataClass: row.data_class,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    firstSeenAt: row.first_seen_at,
  });
}

/** Builds the shared `WHERE` fragment for log queries and stats. */
function logFilters(query: LogQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.app !== undefined) {
    clauses.push("app = ?");
    params.push(query.app);
  }
  if (query.tool !== undefined) {
    clauses.push("tool = ?");
    params.push(query.tool);
  }
  if (query.verdict !== undefined) {
    clauses.push("verdict = ?");
    params.push(query.verdict);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.agentId !== undefined) {
    clauses.push("agent_id = ?");
    params.push(query.agentId);
  }
  if (query.dataClass !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(guard_logs.data_classes_json) WHERE json_each.value = ?)",
    );
    params.push(query.dataClass);
  }
  if (query.since !== undefined) {
    clauses.push("timestamp >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    clauses.push("timestamp <= ?");
    params.push(query.until);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Opens (or adopts) a SQLite database and returns a `GuardStorage` over it. */
export function sqliteStorage(options: SqliteStorageOptions = {}): GuardStorage {
  const { db, owned } = openDatabase(options);
  let closed = false;

  function applySchema(): void {
    db.exec(SCHEMA_SQL);
  }

  applySchema();

  function nextSeq(table: "guard_rules" | "guard_logs"): number {
    const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max FROM ${table}`).get() as {
      max: number;
    };
    return row.max + 1;
  }

  function selectRule(id: string): Rule | null {
    const row = db.prepare("SELECT * FROM guard_rules WHERE id = ?").get(id) as RuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  function selectRules(): Rule[] {
    const rows = db
      .prepare("SELECT * FROM guard_rules ORDER BY priority ASC, seq ASC")
      .all() as RuleRow[];
    return rows.map(rowToRule);
  }

  function insertRule(rule: Rule): void {
    db.prepare(
      `INSERT INTO guard_rules (id, seq, name, enabled, priority, match_json, action_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rule.id,
      nextSeq("guard_rules"),
      rule.name,
      rule.enabled ? 1 : 0,
      rule.priority,
      JSON.stringify(rule.match),
      JSON.stringify(rule.action),
    );
  }

  function mintRuleId(name: string): string {
    const base = slugifyRuleId(name);
    const taken = new Set(
      (db.prepare("SELECT id FROM guard_rules").all() as { id: string }[]).map((row) => row.id),
    );
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  function readDefaultAction(): PolicyDefaultAction {
    const row = db
      .prepare("SELECT value FROM guard_settings WHERE key = ?")
      .get(DEFAULT_ACTION_KEY) as { value: string } | undefined;
    return row?.value === "deny" ? "deny" : "allow";
  }

  function selectLog(id: string): LogRecord | null {
    const row = db.prepare("SELECT * FROM guard_logs WHERE id = ?").get(id) as LogRow | undefined;
    return row ? rowToLog(row) : null;
  }

  function insertLog(entry: LogRecord): void {
    db.prepare(
      `INSERT INTO guard_logs (
         id, seq, status, timestamp, app, tool, verdict, agent_id, agent_json, session_json,
         data_classes_json, rule_ids_json, duration_ms, payloads_json, justification, message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      nextSeq("guard_logs"),
      entry.status,
      entry.timestamp,
      entry.app,
      entry.tool,
      entry.verdict,
      entry.agent.agentId ?? null,
      JSON.stringify(entry.agent),
      entry.session === undefined ? null : JSON.stringify(entry.session),
      JSON.stringify(entry.dataClasses),
      JSON.stringify(entry.ruleIds),
      entry.durationMs,
      JSON.stringify(entry.payloads),
      entry.justification ?? null,
      entry.message ?? null,
    );
  }

  function countLogs(query: LogQuery): number {
    const { sql, params } = logFilters(query);
    const row = db.prepare(`SELECT COUNT(*) AS count FROM guard_logs ${sql}`).get(...params) as {
      count: number;
    };
    return row.count;
  }

  function statsScalars(range: StatsRange): {
    total: number;
    denied: number;
    transformed: number;
    agents: number;
  } {
    const { sql, params } = logFilters(range);
    return db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN verdict = 'deny' THEN 1 ELSE 0 END), 0) AS denied,
           COALESCE(SUM(CASE WHEN json_array_length(data_classes_json) > 0 THEN 1 ELSE 0 END), 0)
             AS transformed,
           COUNT(DISTINCT CASE WHEN agent_id IS NOT NULL AND agent_id <> '' THEN agent_id END)
             AS agents
         FROM guard_logs ${sql}`,
      )
      .get(...params) as { total: number; denied: number; transformed: number; agents: number };
  }

  return {
    async init() {
      // Opening already applied the schema; re-running it keeps `init()`
      // meaningful for adapters that need an explicit migration step.
      applySchema();
    },

    async close() {
      if (closed || !owned) return;
      closed = true;
      db.close();
    },

    async getPolicy(): Promise<PolicyDocument> {
      return {
        version: POLICY_VERSION,
        defaultAction: readDefaultAction(),
        rules: selectRules(),
      };
    },

    async listRules(): Promise<Rule[]> {
      return selectRules();
    },

    async getRule(id: string): Promise<Rule | null> {
      return selectRule(id);
    },

    async createRule(draft: RuleDraft): Promise<Rule> {
      const create = db.transaction((): Rule => {
        if (draft.id !== undefined && selectRule(draft.id) !== null) {
          throw new GuardStorageError(
            "duplicate-rule",
            `A rule with id "${draft.id}" already exists.`,
          );
        }

        const maxPriority = db
          .prepare("SELECT COALESCE(MAX(priority), 0) AS max FROM guard_rules")
          .get() as {
          max: number;
        };
        const count = db.prepare("SELECT COUNT(*) AS count FROM guard_rules").get() as {
          count: number;
        };

        const rule = RuleSchema.parse({
          id: draft.id ?? mintRuleId(draft.name),
          name: draft.name,
          enabled: draft.enabled ?? true,
          priority:
            draft.priority ?? (count.count === 0 ? PRIORITY_STEP : maxPriority.max + PRIORITY_STEP),
          match: draft.match,
          action: draft.action,
        });

        insertRule(rule);
        return rule;
      });

      return create();
    },

    async updateRule(id: string, patch: RulePatch): Promise<Rule | null> {
      const update = db.transaction((): Rule | null => {
        const existing = selectRule(id);
        if (!existing) return null;

        const updated = RuleSchema.parse({
          ...existing,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.match !== undefined ? { match: patch.match } : {}),
          ...(patch.action !== undefined ? { action: patch.action } : {}),
        });

        db.prepare(
          `UPDATE guard_rules
           SET name = ?, enabled = ?, priority = ?, match_json = ?, action_json = ?
           WHERE id = ?`,
        ).run(
          updated.name,
          updated.enabled ? 1 : 0,
          updated.priority,
          JSON.stringify(updated.match),
          JSON.stringify(updated.action),
          id,
        );

        return updated;
      });

      return update();
    },

    async deleteRule(id: string): Promise<boolean> {
      return db.prepare("DELETE FROM guard_rules WHERE id = ?").run(id).changes > 0;
    },

    async reorderRules(ids: string[]): Promise<Rule[]> {
      const reorder = db.transaction((): Rule[] => {
        const seen = new Set<string>();
        for (const id of ids) {
          if (seen.has(id)) {
            throw new GuardStorageError("invalid-argument", `Rule id "${id}" appears twice.`);
          }
          if (selectRule(id) === null) {
            throw new GuardStorageError("unknown-rule", `No rule with id "${id}".`);
          }
          seen.add(id);
        }

        const trailing = selectRules()
          .map((rule) => rule.id)
          .filter((id) => !seen.has(id));

        const statement = db.prepare("UPDATE guard_rules SET priority = ? WHERE id = ?");
        [...ids, ...trailing].forEach((id, index) => {
          statement.run((index + 1) * PRIORITY_STEP, id);
        });

        return selectRules();
      });

      return reorder();
    },

    async getDefaultAction(): Promise<PolicyDefaultAction> {
      return readDefaultAction();
    },

    async setDefaultAction(action: PolicyDefaultAction): Promise<void> {
      db.prepare(
        `INSERT INTO guard_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(DEFAULT_ACTION_KEY, action);
    },

    async appendLog(entry: LogRecord): Promise<LogRecord> {
      const append = db.transaction((): LogRecord => {
        if (selectLog(entry.id) !== null) {
          throw new GuardStorageError(
            "invalid-argument",
            `A log entry with id "${entry.id}" exists.`,
          );
        }
        insertLog(entry);
        const stored = selectLog(entry.id);
        if (!stored) throw new Error("Log entry vanished immediately after insert.");
        return stored;
      });

      return append();
    },

    async completeLog(callId: string, completion: LogCompletion): Promise<LogRecord | null> {
      const complete = db.transaction((): LogRecord | null => {
        const existing = selectLog(callId);
        // Single-shot: only a pending entry can be completed, so a replayed
        // /transform cannot rewrite an audit record that is already closed.
        if (!existing || existing.status !== "pending") return null;

        const merged: LogRecord = {
          ...existing,
          status: "complete",
          ...(completion.verdict !== undefined ? { verdict: completion.verdict } : {}),
          ...(completion.dataClasses !== undefined ? { dataClasses: completion.dataClasses } : {}),
          ...(completion.ruleIds !== undefined ? { ruleIds: completion.ruleIds } : {}),
          ...(completion.durationMs !== undefined ? { durationMs: completion.durationMs } : {}),
          ...(completion.message !== undefined ? { message: completion.message } : {}),
          ...(completion.justification !== undefined
            ? { justification: completion.justification }
            : {}),
          payloads: { ...existing.payloads, ...(completion.payloads ?? {}) },
        };

        db.prepare(
          `UPDATE guard_logs
           SET status = ?, verdict = ?, data_classes_json = ?, rule_ids_json = ?, duration_ms = ?,
               payloads_json = ?, justification = ?, message = ?
           WHERE id = ?`,
        ).run(
          merged.status,
          merged.verdict,
          JSON.stringify(merged.dataClasses),
          JSON.stringify(merged.ruleIds),
          merged.durationMs,
          JSON.stringify(merged.payloads),
          merged.justification ?? null,
          merged.message ?? null,
          callId,
        );

        return selectLog(callId);
      });

      return complete();
    },

    async getLog(id: string): Promise<LogRecord | null> {
      return selectLog(id);
    },

    async queryLogs(query: LogQuery = {}): Promise<LogPage> {
      const { sql, params } = logFilters(query);
      const limit = normalizeLogLimit(query.limit);
      const cursor = query.cursor ? decodeLogCursor(query.cursor) : null;

      const pageClauses: string[] = [];
      const pageParams: unknown[] = [...params];

      if (cursor) {
        pageClauses.push("(timestamp < ? OR (timestamp = ? AND seq < ?))");
        pageParams.push(cursor.timestamp, cursor.timestamp, cursor.seq);
      }

      const where =
        sql.length > 0
          ? pageClauses.length > 0
            ? `${sql} AND ${pageClauses.join(" AND ")}`
            : sql
          : pageClauses.length > 0
            ? `WHERE ${pageClauses.join(" AND ")}`
            : "";

      // One extra row tells us whether another page exists without a second count.
      const offset =
        !cursor && query.offset !== undefined && query.offset > 0 ? Math.floor(query.offset) : 0;

      const rows = db
        .prepare(
          `SELECT * FROM guard_logs ${where}
           ORDER BY timestamp DESC, seq DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...pageParams, limit + 1, offset) as LogRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        entries: page.map(rowToLog),
        total: countLogs(query),
        ...(hasMore && last
          ? { nextCursor: encodeLogCursor({ timestamp: last.timestamp, seq: last.seq }) }
          : {}),
      };
    },

    async stats(range: StatsRange = {}): Promise<GuardStats> {
      const { sql, params } = logFilters(range);
      const scalars = statsScalars(range);

      const byTool = db
        .prepare(
          `SELECT tool, COUNT(*) AS count FROM guard_logs ${sql}
           GROUP BY tool ORDER BY count DESC, tool ASC`,
        )
        .all(...params) as ToolCount[];

      const byDay = db
        .prepare(
          `SELECT
             substr(timestamp, 1, 10) AS day,
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN verdict = 'deny' THEN 1 ELSE 0 END), 0) AS denied,
             COALESCE(SUM(CASE WHEN json_array_length(data_classes_json) > 0 THEN 1 ELSE 0 END), 0)
               AS transformed
           FROM guard_logs ${sql}
           GROUP BY day ORDER BY day ASC`,
        )
        .all(...params) as DayCount[];

      return {
        totalCalls: scalars.total,
        denied: scalars.denied,
        transformed: scalars.transformed,
        uniqueAgents: scalars.agents,
        byTool,
        byDay,
      };
    },

    async putVaultEntry(entry: VaultEntry): Promise<VaultEntry> {
      const put = db.transaction((): VaultEntry => {
        // First write wins: `firstSeenAt` must keep pointing at the first
        // sighting of the value, and the ciphertext already in the vault is the
        // one every existing token reference decrypts to.
        db.prepare(
          `INSERT INTO guard_vault (token, data_class, ciphertext, iv, auth_tag, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (token) DO NOTHING`,
        ).run(
          entry.token,
          entry.dataClass,
          entry.ciphertext,
          entry.iv,
          entry.authTag,
          entry.firstSeenAt,
        );

        const row = db.prepare("SELECT * FROM guard_vault WHERE token = ?").get(entry.token) as
          VaultRow | undefined;
        if (!row) throw new Error("Vault entry vanished immediately after insert.");
        return rowToVaultEntry(row);
      });

      return put();
    },

    async getVaultEntry(token: string): Promise<VaultEntry | null> {
      const row = db.prepare("SELECT * FROM guard_vault WHERE token = ?").get(token) as
        VaultRow | undefined;
      return row ? rowToVaultEntry(row) : null;
    },
  };
}
