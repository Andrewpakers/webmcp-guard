import {
  GuardStorageError,
  POLICY_VERSION,
  decodeLogCursor,
  encodeLogCursor,
  normalizeLogLimit,
  slugifyRuleId,
  type ConfirmationEntry,
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
  type VaultEntry,
} from "@webmcp-guard/shared";

/**
 * `@webmcp-guard/storage-memory` — the in-memory `GuardStorage` adapter.
 *
 * Two jobs: it is the store the unit tests run against, and it is the worked
 * example of the "bring your own database" contract
 * (`docs/04-sdk-requirements.md`) — a complete adapter in one readable file.
 *
 * Nothing here is process-safe or durable. Use `@webmcp-guard/storage-sqlite`
 * (or your own adapter) for anything you want to keep.
 */
export const PACKAGE_NAME = "@webmcp-guard/storage-memory" as const;

/**
 * Every value crossing the storage boundary is deep-copied through JSON, which
 * does two things at once: callers cannot mutate stored state by keeping a
 * reference, and this adapter drops `undefined` object members exactly like the
 * SQLite adapter does. Adapters that disagree about that would make the shared
 * conformance suite a lie.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Code-unit comparison, matching SQLite's BINARY collation. */
function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface RuleSlot {
  rule: Rule;
  /** Insertion order, so equal priorities keep the order they were created in. */
  seq: number;
}

interface LogSlot {
  record: LogRecord;
  seq: number;
}

const PRIORITY_STEP = 10;

export interface MemoryStorage extends GuardStorage {
  /** Test/demo helper: forget everything without reallocating the adapter. */
  reset(): void;
}

/** Creates an empty in-memory store. */
export function memoryStorage(): MemoryStorage {
  const rules = new Map<string, RuleSlot>();
  const logs = new Map<string, LogSlot>();
  const vault = new Map<string, VaultEntry>();
  const confirmations = new Map<string, ConfirmationEntry>();
  let defaultAction: PolicyDefaultAction = "allow";
  let ruleSeq = 0;
  let logSeq = 0;

  function orderedRules(): Rule[] {
    return [...rules.values()]
      .sort((a, b) => a.rule.priority - b.rule.priority || a.seq - b.seq)
      .map((slot) => cloneJson(slot.rule));
  }

  function nextPriority(): number {
    let max = 0;
    for (const slot of rules.values()) max = Math.max(max, slot.rule.priority);
    return rules.size === 0 ? PRIORITY_STEP : max + PRIORITY_STEP;
  }

  function mintRuleId(name: string): string {
    const base = slugifyRuleId(name);
    if (!rules.has(base)) return base;
    let suffix = 2;
    while (rules.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  function matchesQuery(record: LogRecord, query: LogQuery): boolean {
    if (query.app !== undefined && record.app !== query.app) return false;
    if (query.tool !== undefined && record.tool !== query.tool) return false;
    if (query.verdict !== undefined && record.verdict !== query.verdict) return false;
    if (query.status !== undefined && record.status !== query.status) return false;
    if (query.agentId !== undefined && record.agent.agentId !== query.agentId) return false;
    if (query.dataClass !== undefined && !record.dataClasses.includes(query.dataClass))
      return false;
    if (query.since !== undefined && record.timestamp < query.since) return false;
    if (query.until !== undefined && record.timestamp > query.until) return false;
    return true;
  }

  /** Newest first; ties (same ISO timestamp) fall back to insertion order. */
  function newestFirst(a: LogSlot, b: LogSlot): number {
    if (a.record.timestamp === b.record.timestamp) return b.seq - a.seq;
    return a.record.timestamp < b.record.timestamp ? 1 : -1;
  }

  function inRange(record: LogRecord, since?: string, until?: string): boolean {
    if (since !== undefined && record.timestamp < since) return false;
    if (until !== undefined && record.timestamp > until) return false;
    return true;
  }

  return {
    async init() {
      // Nothing to create: the Maps above are the schema.
    },

    async close() {
      // Nothing to release. Deliberately does *not* clear state, so a caller
      // that closes and keeps using the handle sees the same data (matching
      // SQLite's `:memory:` semantics closely enough for tests).
    },

    reset() {
      rules.clear();
      logs.clear();
      vault.clear();
      confirmations.clear();
      defaultAction = "allow";
      ruleSeq = 0;
      logSeq = 0;
    },

    async getPolicy(): Promise<PolicyDocument> {
      return { version: POLICY_VERSION, defaultAction, rules: orderedRules() };
    },

    async listRules(): Promise<Rule[]> {
      return orderedRules();
    },

    async getRule(id: string): Promise<Rule | null> {
      const slot = rules.get(id);
      return slot ? cloneJson(slot.rule) : null;
    },

    async createRule(draft: RuleDraft): Promise<Rule> {
      if (draft.id !== undefined && rules.has(draft.id)) {
        throw new GuardStorageError(
          "duplicate-rule",
          `A rule with id "${draft.id}" already exists.`,
        );
      }

      const rule: Rule = cloneJson({
        id: draft.id ?? mintRuleId(draft.name),
        name: draft.name,
        enabled: draft.enabled ?? true,
        priority: draft.priority ?? nextPriority(),
        match: draft.match,
        action: draft.action,
      });

      ruleSeq += 1;
      rules.set(rule.id, { rule, seq: ruleSeq });
      return cloneJson(rule);
    },

    async updateRule(id: string, patch: RulePatch): Promise<Rule | null> {
      const slot = rules.get(id);
      if (!slot) return null;

      const updated: Rule = cloneJson({
        ...slot.rule,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.match !== undefined ? { match: patch.match } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
      });

      rules.set(id, { rule: updated, seq: slot.seq });
      return cloneJson(updated);
    },

    async deleteRule(id: string): Promise<boolean> {
      return rules.delete(id);
    },

    async reorderRules(ids: string[]): Promise<Rule[]> {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new GuardStorageError("invalid-argument", `Rule id "${id}" appears twice.`);
        }
        if (!rules.has(id)) {
          throw new GuardStorageError("unknown-rule", `No rule with id "${id}".`);
        }
        seen.add(id);
      }

      const trailing = orderedRules()
        .map((rule) => rule.id)
        .filter((id) => !seen.has(id));

      [...ids, ...trailing].forEach((id, index) => {
        const slot = rules.get(id);
        if (!slot) return;
        slot.rule.priority = (index + 1) * PRIORITY_STEP;
      });

      return orderedRules();
    },

    async getDefaultAction(): Promise<PolicyDefaultAction> {
      return defaultAction;
    },

    async setDefaultAction(action: PolicyDefaultAction): Promise<void> {
      defaultAction = action;
    },

    async appendLog(entry: LogRecord): Promise<LogRecord> {
      if (logs.has(entry.id)) {
        throw new GuardStorageError(
          "invalid-argument",
          `A log entry with id "${entry.id}" exists.`,
        );
      }
      const record = cloneJson(entry);
      logSeq += 1;
      logs.set(record.id, { record, seq: logSeq });
      return cloneJson(record);
    },

    async completeLog(callId: string, completion: LogCompletion): Promise<LogRecord | null> {
      const slot = logs.get(callId);
      // Single-shot: an already-complete entry is not completable again, so a
      // replayed /transform cannot rewrite a closed audit record.
      if (!slot || slot.record.status !== "pending") return null;

      const record: LogRecord = cloneJson({
        ...slot.record,
        status: "complete",
        ...(completion.verdict !== undefined ? { verdict: completion.verdict } : {}),
        ...(completion.dataClasses !== undefined ? { dataClasses: completion.dataClasses } : {}),
        ...(completion.ruleIds !== undefined ? { ruleIds: completion.ruleIds } : {}),
        ...(completion.durationMs !== undefined ? { durationMs: completion.durationMs } : {}),
        ...(completion.message !== undefined ? { message: completion.message } : {}),
        ...(completion.justification !== undefined
          ? { justification: completion.justification }
          : {}),
        ...(completion.justificationVerdict !== undefined
          ? { justificationVerdict: completion.justificationVerdict }
          : {}),
        payloads: { ...slot.record.payloads, ...(completion.payloads ?? {}) },
      });

      logs.set(callId, { record, seq: slot.seq });
      return cloneJson(record);
    },

    async getLog(id: string): Promise<LogRecord | null> {
      const slot = logs.get(id);
      return slot ? cloneJson(slot.record) : null;
    },

    async queryLogs(query: LogQuery = {}): Promise<LogPage> {
      const matching = [...logs.values()]
        .filter((slot) => matchesQuery(slot.record, query))
        .sort(newestFirst);

      const limit = normalizeLogLimit(query.limit);
      const cursor = query.cursor ? decodeLogCursor(query.cursor) : null;

      let start = 0;
      if (cursor) {
        // Keyset: resume immediately after the cursor position in this order.
        start = matching.findIndex(
          (slot) =>
            slot.record.timestamp < cursor.timestamp ||
            (slot.record.timestamp === cursor.timestamp && slot.seq < cursor.seq),
        );
        if (start < 0) start = matching.length;
      } else if (query.offset !== undefined && query.offset > 0) {
        start = Math.floor(query.offset);
      }

      const page = matching.slice(start, start + limit);
      const last = page.at(-1);
      const hasMore = start + page.length < matching.length;

      return {
        entries: page.map((slot) => cloneJson(slot.record)),
        total: matching.length,
        ...(hasMore && last
          ? { nextCursor: encodeLogCursor({ timestamp: last.record.timestamp, seq: last.seq }) }
          : {}),
      };
    },

    async stats(range = {}): Promise<GuardStats> {
      const matching = [...logs.values()]
        .map((slot) => slot.record)
        .filter((record) => inRange(record, range.since, range.until));

      const byTool = new Map<string, number>();
      const byDay = new Map<string, DayCount>();
      const agents = new Set<string>();
      let denied = 0;
      let transformed = 0;

      for (const record of matching) {
        const isDenied = record.verdict === "deny";
        const isTransformed = record.dataClasses.length > 0;
        if (isDenied) denied += 1;
        if (isTransformed) transformed += 1;
        if (record.agent.agentId) agents.add(record.agent.agentId);

        byTool.set(record.tool, (byTool.get(record.tool) ?? 0) + 1);

        const day = record.timestamp.slice(0, 10);
        const bucket = byDay.get(day) ?? { day, total: 0, denied: 0, transformed: 0 };
        bucket.total += 1;
        if (isDenied) bucket.denied += 1;
        if (isTransformed) bucket.transformed += 1;
        byDay.set(day, bucket);
      }

      return {
        totalCalls: matching.length,
        denied,
        transformed,
        uniqueAgents: agents.size,
        byTool: [...byTool.entries()]
          .map(([tool, count]) => ({ tool, count }))
          // Byte order, not locale order: SQLite's default collation is BINARY,
          // and the two adapters have to agree for the conformance suite.
          .sort((a, b) => b.count - a.count || compareBytes(a.tool, b.tool)),
        byDay: [...byDay.values()].sort((a, b) => compareBytes(a.day, b.day)),
      };
    },

    async putVaultEntry(entry: VaultEntry): Promise<VaultEntry> {
      // First write wins so `firstSeenAt` keeps pointing at the first sighting.
      const existing = vault.get(entry.token);
      if (existing) return cloneJson(existing);
      vault.set(entry.token, cloneJson(entry));
      return cloneJson(entry);
    },

    async getVaultEntry(token: string): Promise<VaultEntry | null> {
      const entry = vault.get(token);
      return entry ? cloneJson(entry) : null;
    },

    async putConfirmation(entry: ConfirmationEntry): Promise<ConfirmationEntry> {
      // Contract: storing a confirmation evicts the ones that have expired.
      // Declined approvals are never consumed, so without this the map only
      // ever grows.
      const now = Date.now();
      for (const [id, pending] of confirmations) {
        // `!(… >= now)` also evicts an unparsable expiry, which is the safe
        // direction: a confirmation nobody can date is not one to keep.
        if (!(Date.parse(pending.expiresAt) >= now)) confirmations.delete(id);
      }

      confirmations.set(entry.id, cloneJson(entry));
      return cloneJson(entry);
    },

    async consumeConfirmation(id: string): Promise<ConfirmationEntry | null> {
      const entry = confirmations.get(id);
      if (!entry) return null;
      // Single-use. JavaScript's run-to-completion semantics make the
      // get/delete pair atomic here: no `await` separates them, so two racing
      // consumers cannot both see the entry.
      confirmations.delete(id);
      return cloneJson(entry);
    },
  };
}
