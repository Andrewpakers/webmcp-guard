import { z } from "zod";

import { DataClassSchema, type DataClass } from "./data-class";
import { LogEntrySchema, type LogJustificationVerdict, type LogPayloads } from "./log";
import type { PolicyDocument, Rule, RuleAction, RuleMatch } from "./policy";
import type { GateVerdict } from "./wire";

/**
 * `GuardStorage` — the "bring your own database" seam (`docs/04-sdk-requirements.md`).
 *
 * Everything WebMCP Guard persists goes through this interface: the single
 * policy document, the audit log, and the token vault. The demo ships two
 * adapters (`@webmcp-guard/storage-memory`, `@webmcp-guard/storage-sqlite`) and
 * a conformance kit (`@webmcp-guard/shared/storage-contract`) so a company can
 * write a third against its own database and prove it behaves identically.
 *
 * Design rules for implementers:
 *
 * 1. **Every method is async.** The bundled adapters are synchronous inside,
 *    but the signatures leave room for adapters that talk to a remote store.
 * 2. **Values crossing the boundary are JSON-safe and defensively copied.**
 *    Callers must never be able to mutate stored state by holding onto a
 *    returned object, and `undefined` inside a payload does not survive a
 *    round trip (it is dropped, exactly as `JSON.stringify` would).
 * 3. **There is exactly one policy document.** Multi-tenancy is out of scope
 *    (`docs/06-console-requirements.md` non-goals); rules scope themselves to
 *    apps through `match.apps`.
 */

/** Page size used when a caller does not ask for one. */
export const LOG_QUERY_DEFAULT_LIMIT = 50;

/** Hard ceiling on a page, so a console bug cannot ask for the whole table. */
export const LOG_QUERY_MAX_LIMIT = 200;

/**
 * Lifecycle of a log entry. `/gate` writes a `pending` entry when it lets a
 * call through, and `/transform` completes it once the tool has run. Anything
 * that ends the call at the gate (a denial, a required confirmation) is written
 * `complete` straight away.
 *
 * This lives here rather than in `LogEntrySchema` because it is a storage
 * concern, not part of the audit record the console renders.
 */
export const LOG_STATUSES = ["pending", "complete"] as const;

export const LogStatusSchema = z.enum(LOG_STATUSES);

export type LogStatus = z.infer<typeof LogStatusSchema>;

/** A stored audit entry: the shared `LogEntry` plus its lifecycle status. */
export const LogRecordSchema = LogEntrySchema.extend({ status: LogStatusSchema });

export type LogRecord = z.infer<typeof LogRecordSchema>;

/** `"allow" | "deny"` — the baseline when no rule matches. */
export type PolicyDefaultAction = PolicyDocument["defaultAction"];

/**
 * A new rule as the console (or the seeder) supplies it. The adapter fills in
 * what is missing: a generated `id`, `enabled: true`, and a `priority` that
 * puts the rule at the end of the ordered list.
 */
export interface RuleDraft {
  id?: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  match: RuleMatch;
  action: RuleAction;
}

/** Fields `updateRule` can change. `id` is immutable — delete and recreate. */
export interface RulePatch {
  name?: string;
  enabled?: boolean;
  priority?: number;
  match?: RuleMatch;
  action?: RuleAction;
}

/**
 * The second half of a log entry, written when the tool call returns.
 * `payloads` is merged key-by-key over what `appendLog` stored; every other
 * field replaces its predecessor.
 */
export interface LogCompletion {
  verdict?: GateVerdict;
  dataClasses?: DataClass[];
  ruleIds?: string[];
  durationMs?: number;
  payloads?: Partial<LogPayloads>;
  message?: string;
  justification?: string;
  justificationVerdict?: LogJustificationVerdict;
}

/**
 * Audit-log filters, one per console filter control
 * (`docs/06-console-requirements.md` §1). Every filter is exact-match except
 * the time bounds, which are **inclusive** ISO-8601 strings compared
 * lexicographically (all timestamps are UTC `toISOString()` output).
 */
export interface LogQuery {
  app?: string;
  tool?: string;
  verdict?: GateVerdict;
  /** Matches entries whose `dataClasses` array contains this class. */
  dataClass?: DataClass;
  /** Matches `agent.agentId` exactly. */
  agentId?: string;
  status?: LogStatus;
  /** Inclusive lower bound on `timestamp`. */
  since?: string;
  /** Inclusive upper bound on `timestamp`. */
  until?: string;
  /** Defaults to {@link LOG_QUERY_DEFAULT_LIMIT}, capped at {@link LOG_QUERY_MAX_LIMIT}. */
  limit?: number;
  /** Offset pagination. Ignored when `cursor` is supplied. */
  offset?: number;
  /** Keyset pagination: the `nextCursor` of the previous page. */
  cursor?: string;
}

/** One page of audit entries, newest first. */
export interface LogPage {
  entries: LogRecord[];
  /** Total entries matching the filters, ignoring pagination. */
  total: number;
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface StatsRange {
  /** Inclusive ISO-8601 lower bound. */
  since?: string;
  /** Inclusive ISO-8601 upper bound. */
  until?: string;
}

export interface ToolCount {
  tool: string;
  count: number;
}

/** One UTC day (`YYYY-MM-DD`) of activity, for the console's stacked chart. */
export interface DayCount {
  day: string;
  total: number;
  denied: number;
  transformed: number;
}

/**
 * Dashboard counters (`docs/06-console-requirements.md` §3). Deliberately
 * small: four scalars plus two series, which is exactly what the stat cards
 * and the two charts need.
 *
 * - `denied` counts entries with verdict `deny`.
 * - `transformed` counts entries where the pipeline actually touched data
 *   (`dataClasses` non-empty). Always `0` until Phase 3 ships the classifier.
 * - `uniqueAgents` counts distinct non-empty `agent.agentId` values; entries
 *   from an unidentified agent are not counted as an agent.
 */
export interface GuardStats {
  totalCalls: number;
  denied: number;
  transformed: number;
  uniqueAgents: number;
  /** Descending by count, then ascending by tool name. */
  byTool: ToolCount[];
  /** Ascending by day. */
  byDay: DayCount[];
}

/**
 * A vault row: `token -> AES-256-GCM(value)`. Phase 3 owns the crypto; the
 * shape is fixed here so the adapters (and their schema migrations) are done
 * once. All binary fields are base64.
 */
export const VaultEntrySchema = z
  .object({
    /** `tok_<class>_<hex8>` — deterministic, so it is also the primary key. */
    token: z.string().min(1),
    dataClass: DataClassSchema,
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    /** ISO-8601 timestamp of the first sighting; never overwritten. */
    firstSeenAt: z.string().datetime(),
  })
  .strict();

export type VaultEntry = z.infer<typeof VaultEntrySchema>;

/**
 * A pending human confirmation: the one-time id `/gate` issues for a
 * `require-confirmation` verdict (`docs/03-architecture.md`: "the server issues
 * a one-time confirmation id so the approval can't be replayed").
 *
 * The row binds the approval to one call: the same app, the same tool, and —
 * through `argsHash` — the exact arguments the human was shown. Nothing here is
 * secret, so nothing here is encrypted: `argsHash` is a SHA-256 of the
 * canonicalized call, which is a *binding*, not a way to recover the arguments.
 */
export const ConfirmationEntrySchema = z
  .object({
    /** Unguessable one-time id (a v4 UUID from the server's CSPRNG). */
    id: z.string().min(1),
    app: z.string().min(1),
    tool: z.string().min(1),
    /** Hex SHA-256 over the canonical JSON of `(app, tool, args)`. */
    argsHash: z.string().min(1),
    /** The audit entry of the gate call that asked for the confirmation. */
    callId: z.string().min(1),
    issuedAt: z.string().datetime(),
    /** ISO-8601. Expiry is judged by the caller, not by `consumeConfirmation`. */
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ConfirmationEntry = z.infer<typeof ConfirmationEntrySchema>;

export type GuardStorageErrorCode = "duplicate-rule" | "unknown-rule" | "invalid-argument";

/**
 * The only error type adapters throw for expected, caller-fixable conditions,
 * so the server can map a storage failure onto an HTTP status without
 * string-matching messages. Anything else that escapes an adapter is a bug or
 * an infrastructure failure and becomes a 500.
 */
export class GuardStorageError extends Error {
  readonly code: GuardStorageErrorCode;

  constructor(code: GuardStorageErrorCode, message: string) {
    super(message);
    this.name = "GuardStorageError";
    this.code = code;
  }
}

/** Keyset pagination position: the last entry of the page just returned. */
export interface LogCursor {
  timestamp: string;
  /** Adapter-assigned insertion sequence, breaking timestamp ties. */
  seq: number;
}

/**
 * Cursors are opaque to callers but must mean the same thing in every adapter,
 * so the codec lives here rather than being reinvented per adapter.
 *
 * `btoa`/`atob` (rather than `Buffer`) keeps this module importable from the
 * browser SDK, which pulls its types from the same package. The encoded string
 * is ASCII-only and URL-safe, so it survives a round trip through a query
 * string untouched. A cursor carries no authority — it is a position, and
 * `/logs` is admin-gated regardless.
 */
export function encodeLogCursor(cursor: LogCursor): string {
  return btoa(`${cursor.seq}|${cursor.timestamp}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Returns `null` for anything that is not a cursor this codec produced. */
export function decodeLogCursor(raw: string): LogCursor | null {
  let decoded: string;
  try {
    decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const seq = Number.parseInt(decoded.slice(0, separator), 10);
  const timestamp = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(seq) || seq < 0 || timestamp.length === 0) return null;
  return { seq, timestamp };
}

/**
 * Turns a rule name into the readable id fragment adapters use when the caller
 * does not supply an id (`"Export requires justification"` →
 * `"export-requires-justification"`). Lives here so every adapter mints the
 * same id for the same name.
 */
export function slugifyRuleId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "rule";
}

/** Clamps a caller-supplied page size into the supported range. */
export function normalizeLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LOG_QUERY_DEFAULT_LIMIT;
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, LOG_QUERY_MAX_LIMIT);
}

export interface GuardStorage {
  /**
   * Creates or migrates whatever the adapter needs. Idempotent: the server
   * calls it on every boot, and calling it twice must be harmless.
   */
  init(): Promise<void>;

  /** Releases handles. Idempotent. */
  close(): Promise<void>;

  // ---- policy -------------------------------------------------------------

  /** The whole document: `defaultAction` plus the ordered rules. */
  getPolicy(): Promise<PolicyDocument>;

  /** Ordered by `priority` ascending, ties broken by insertion order. */
  listRules(): Promise<Rule[]>;

  getRule(id: string): Promise<Rule | null>;

  /**
   * @throws {GuardStorageError} `duplicate-rule` when the id is already taken.
   */
  createRule(draft: RuleDraft): Promise<Rule>;

  /** Returns `null` when the rule does not exist. */
  updateRule(id: string, patch: RulePatch): Promise<Rule | null>;

  /** Returns `false` when the rule did not exist. */
  deleteRule(id: string): Promise<boolean>;

  /**
   * Rewrites priorities so the listed rules run in the given order. Rules not
   * mentioned keep their relative order and move to the end.
   *
   * @throws {GuardStorageError} `unknown-rule` for an id that does not exist,
   *   `invalid-argument` for a duplicated id.
   */
  reorderRules(ids: string[]): Promise<Rule[]>;

  getDefaultAction(): Promise<PolicyDefaultAction>;

  setDefaultAction(action: PolicyDefaultAction): Promise<void>;

  // ---- audit log ----------------------------------------------------------

  /**
   * Writes a new entry. `entry.id` is the `callId` the gate handed the SDK, so
   * the transform half can find it again.
   *
   * @throws {GuardStorageError} `invalid-argument` when the id is already used.
   */
  appendLog(entry: LogRecord): Promise<LogRecord>;

  /**
   * Completes a `pending` entry and returns it.
   *
   * Returns `null` when there is no pending entry with that id — including
   * when the entry exists but is already `complete`. That makes the
   * transition single-shot: a replayed `/transform` call cannot overwrite an
   * audit record that was already closed.
   */
  completeLog(callId: string, completion: LogCompletion): Promise<LogRecord | null>;

  getLog(id: string): Promise<LogRecord | null>;

  /** Newest first. */
  queryLogs(query?: LogQuery): Promise<LogPage>;

  // ---- dashboard ----------------------------------------------------------

  stats(range?: StatsRange): Promise<GuardStats>;

  // ---- token vault (Phase 3) ---------------------------------------------

  /**
   * Idempotent insert keyed by `token`. First write wins, so `firstSeenAt`
   * keeps pointing at the first time the value was seen. Returns the stored
   * row (the pre-existing one when there was a collision).
   */
  putVaultEntry(entry: VaultEntry): Promise<VaultEntry>;

  getVaultEntry(token: string): Promise<VaultEntry | null>;

  // ---- pending human confirmations (Phase 5) ------------------------------

  /**
   * Stores a one-time confirmation. Ids come from the server's CSPRNG, so a
   * collision is not a case worth designing for: implementations may simply
   * overwrite.
   *
   * **Adapters must evict entries whose `expiresAt` has passed** when a new one
   * is stored. Confirmations that are never consumed (the human declined, or
   * walked away) would otherwise accumulate forever, and eviction on write is
   * the cheapest place to do it without a background job.
   */
  putConfirmation(entry: ConfirmationEntry): Promise<ConfirmationEntry>;

  /**
   * Atomically removes the confirmation and returns it; `null` when there is no
   * entry with that id — including when it was already consumed. **Single use
   * is the whole point**: the second call for an id must return `null` even if
   * two requests race.
   *
   * Deliberately does *not* check `expiresAt`. An expired id is still returned
   * (and still destroyed) so that the caller can burn a replay attempt before
   * judging it — see the `/gate` confirmation flow in
   * `packages/server/src/server.ts`.
   */
  consumeConfirmation(id: string): Promise<ConfirmationEntry | null>;
}
