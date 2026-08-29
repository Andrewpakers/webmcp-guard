import {
  DATA_CLASSES,
  GATE_VERDICTS,
  LOG_QUERY_DEFAULT_LIMIT,
  type DataClass,
  type GateVerdict,
  type LogQuery,
} from "@webmcp-guard/shared";

/**
 * The audit-log filter bar (`docs/06-console-requirements.md` §1) as plain
 * data, so the mapping from "what the operator typed" to "what `GET /logs`
 * receives" is a pure function with tests rather than logic scattered through a
 * component.
 */

export interface LogFilterState {
  tool: string;
  verdict: "" | GateVerdict;
  dataClass: "" | DataClass;
  agent: string;
  /** `<input type="datetime-local">` values — local wall time, no zone. */
  since: string;
  until: string;
}

export const EMPTY_LOG_FILTERS: LogFilterState = {
  tool: "",
  verdict: "",
  dataClass: "",
  agent: "",
  since: "",
  until: "",
};

export const VERDICT_OPTIONS = GATE_VERDICTS;
export const DATA_CLASS_OPTIONS = DATA_CLASSES;

export const LOG_PAGE_SIZE = LOG_QUERY_DEFAULT_LIMIT;

/**
 * `2026-08-29T14:30` (local) → `2026-08-29T21:30:00.000Z`.
 *
 * The server compares timestamps as strings against UTC ISO values, so a
 * datetime-local value has to be resolved through the browser's zone first —
 * otherwise "since 9am" means 9am UTC, which is the wrong hour nearly
 * everywhere. Returns `undefined` for blank or unparseable input.
 */
export function datetimeLocalToIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = new Date(trimmed);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return undefined;
  return parsed.toISOString();
}

/** Inverse of {@link datetimeLocalToIso}, for pre-filling the inputs. */
export function isoToDatetimeLocal(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

export interface LogPageState {
  limit?: number;
  offset?: number;
  cursor?: string;
}

/**
 * Filter state + pagination → the `LogQuery` the client sends. Empty controls
 * are omitted entirely rather than sent blank, so the shape of the request
 * mirrors what the operator actually narrowed by.
 */
export function logFiltersToQuery(filters: LogFilterState, page: LogPageState = {}): LogQuery {
  const tool = filters.tool.trim();
  const agent = filters.agent.trim();
  const since = datetimeLocalToIso(filters.since);
  const until = datetimeLocalToIso(filters.until);

  return {
    ...(tool.length > 0 ? { tool } : {}),
    ...(filters.verdict !== "" ? { verdict: filters.verdict } : {}),
    ...(filters.dataClass !== "" ? { dataClass: filters.dataClass } : {}),
    ...(agent.length > 0 ? { agentId: agent } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    limit: page.limit ?? LOG_PAGE_SIZE,
    ...(page.cursor !== undefined
      ? { cursor: page.cursor }
      : page.offset !== undefined && page.offset > 0
        ? { offset: page.offset }
        : {}),
  };
}

/** True when anything is narrowing the view — drives the "clear filters" chip. */
export function hasActiveFilters(filters: LogFilterState): boolean {
  return Object.values(filters).some((value) => value.trim().length > 0);
}

/** `[start, end]` 1-based positions of the current page, for "showing 1–50 of 231". */
export function pageRange(offset: number, count: number, total: number): [number, number] {
  if (count === 0 || total === 0) return [0, 0];
  return [offset + 1, Math.min(offset + count, total)];
}

/** ISO timestamp `hours` before `now` — the dashboard's 24h window. */
export function isoHoursAgo(hours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}
