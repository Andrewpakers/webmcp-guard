import type {
  GuardStats,
  LogPage,
  LogQuery,
  LogRecord,
  PolicyDefaultAction,
  PolicyDocument,
  Rule,
  RuleMatch,
  RuleAction,
  StatsRange,
} from "@webmcp-guard/shared";

import { GuardApiError, guardRequest, type GuardTransportConfig, type QueryValue } from "./client";

/**
 * The typed surface of `packages/server/src/server.ts`, one method per route.
 * Components only ever talk to this — never to `fetch` directly.
 */

/** `POST /policies` body (the server's `CreateRuleSchema`). */
export interface RuleCreateBody {
  id?: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  match: RuleMatch;
  action: RuleAction;
}

/** `PUT /policies/:id` body (the server's `UpdateRuleSchema`, all optional). */
export interface RuleUpdateBody {
  name?: string;
  enabled?: boolean;
  priority?: number;
  match?: RuleMatch;
  action?: RuleAction;
}

export interface RevealResult {
  /** Whether the reveal was recorded server-side as an admin action. */
  logged: boolean;
  /** Present when it was not — the UI shows this next to the revealed payload. */
  reason?: string;
}

export interface GuardClient {
  readonly baseUrl: string;
  getStats(range?: StatsRange, signal?: AbortSignal): Promise<GuardStats>;
  getPolicy(signal?: AbortSignal): Promise<PolicyDocument>;
  getRule(id: string): Promise<Rule>;
  createRule(body: RuleCreateBody): Promise<Rule>;
  updateRule(id: string, body: RuleUpdateBody): Promise<Rule>;
  deleteRule(id: string): Promise<{ id: string; deleted: boolean }>;
  reorderRules(ids: string[]): Promise<PolicyDocument>;
  setDefaultAction(action: PolicyDefaultAction): Promise<PolicyDocument>;
  queryLogs(query?: LogQuery, signal?: AbortSignal): Promise<LogPage>;
  getLog(id: string): Promise<LogRecord>;
  /** Audit the operator revealing an original payload. Never throws. */
  revealLog(logId: string): Promise<RevealResult>;
}

/**
 * `LogQuery` → the query parameters `GET /logs` actually names. The one rename
 * is `agentId` → `agent`; everything else is passed through, and blanks are
 * dropped by the query-string builder.
 */
export function logQueryParams(query: LogQuery | undefined): Record<string, QueryValue> {
  if (query === undefined) return {};
  return {
    app: query.app,
    tool: query.tool,
    verdict: query.verdict,
    dataClass: query.dataClass,
    agent: query.agentId,
    status: query.status,
    since: query.since,
    until: query.until,
    limit: query.limit,
    offset: query.offset,
    cursor: query.cursor,
  };
}

export function statsParams(range: StatsRange | undefined): Record<string, QueryValue> {
  return { since: range?.since, until: range?.until };
}

export function createGuardClient(config: GuardTransportConfig): GuardClient {
  const request = <T>(options: Parameters<typeof guardRequest>[1]) =>
    guardRequest<T>(config, options);

  return {
    baseUrl: config.baseUrl,

    getStats: (range, signal) =>
      request<GuardStats>({ path: "/stats", query: statsParams(range), signal }),

    getPolicy: (signal) => request<PolicyDocument>({ path: "/policies", signal }),

    getRule: (id) => request<Rule>({ path: `/policies/${encodeURIComponent(id)}` }),

    createRule: (body) => request<Rule>({ method: "POST", path: "/policies", body }),

    updateRule: (id, body) =>
      request<Rule>({ method: "PUT", path: `/policies/${encodeURIComponent(id)}`, body }),

    deleteRule: (id) =>
      request<{ id: string; deleted: boolean }>({
        method: "DELETE",
        path: `/policies/${encodeURIComponent(id)}`,
      }),

    reorderRules: (ids) =>
      request<PolicyDocument>({ method: "POST", path: "/policies/reorder", body: { ids } }),

    setDefaultAction: (action) =>
      request<PolicyDocument>({
        method: "PUT",
        path: "/policies",
        body: { defaultAction: action },
      }),

    queryLogs: (query, signal) =>
      request<LogPage>({ path: "/logs", query: logQueryParams(query), signal }),

    getLog: (id) => request<LogRecord>({ path: `/logs/${encodeURIComponent(id)}` }),

    /**
     * Revealing an original payload is itself an audited admin action
     * (`docs/06-console-requirements.md` §1), so the console asks the server to
     * record it before un-masking.
     *
     * It is deliberately fire-and-forget: a `not_found` (a deployment whose
     * vault work has not landed, or a log entry that has since been rotated
     * away) or a `method_not_allowed` must not cost the operator the payload
     * they already hold — the drawer un-masks either way and says plainly that
     * the reveal was not recorded. Nothing here throws.
     */
    async revealLog(logId) {
      try {
        await request<unknown>({ method: "POST", path: "/tokens/reveal", body: { logId } });
        return { logged: true };
      } catch (error) {
        if (
          error instanceof GuardApiError &&
          (error.code === "not_found" || error.code === "method_not_allowed")
        ) {
          console.warn(
            `[console] POST /tokens/reveal answered ${error.code}; revealing without a server-side audit record.`,
          );
          return {
            logged: false,
            reason:
              "POST /tokens/reveal answered not_found — the payload is shown, but this reveal was not recorded in the audit log.",
          };
        }
        return {
          logged: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
