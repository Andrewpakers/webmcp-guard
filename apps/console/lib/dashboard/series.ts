import type { GuardStats } from "@webmcp-guard/shared";

/**
 * `GET /stats` → the two chart series and the four stat cards
 * (`docs/06-console-requirements.md` §3). Pure, so the dashboard components can
 * stay presentational and the shape of every series is pinned by tests.
 */

export interface VerdictDayPoint {
  /** UTC `YYYY-MM-DD`, straight from the server. */
  day: string;
  /** `Aug 29` — formatted without `Date`, so it cannot drift by a timezone. */
  label: string;
  allowed: number;
  transformed: number;
  denied: number;
  total: number;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return day;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return day;
  return `${month} ${Number(match[3])}`;
}

/**
 * Stacked series for "calls over time".
 *
 * The server reports `total`, `denied` and `transformed` per day; `allowed` is
 * the remainder — the calls that ran untouched. Clamped at zero so a future
 * definition where a denied call also counts as transformed can never render a
 * negative segment.
 */
export function callsByDay(stats: GuardStats): VerdictDayPoint[] {
  return stats.byDay.map((entry) => {
    const denied = Math.max(0, entry.denied);
    const transformed = Math.max(0, entry.transformed);
    const allowed = Math.max(0, entry.total - denied - transformed);
    return {
      day: entry.day,
      label: formatDay(entry.day),
      allowed,
      transformed,
      denied,
      total: entry.total,
    };
  });
}

export interface ToolBar {
  tool: string;
  count: number;
}

/**
 * Top tools by call volume. The server already sorts descending; this only caps
 * the list so the bar chart stays readable, and folds the tail into one bar
 * rather than dropping it silently.
 */
export function topTools(stats: GuardStats, limit = 8): ToolBar[] {
  if (stats.byTool.length <= limit) return stats.byTool.map((entry) => ({ ...entry }));

  const head = stats.byTool.slice(0, limit - 1).map((entry) => ({ ...entry }));
  const tail = stats.byTool.slice(limit - 1);
  const rest = tail.reduce((sum, entry) => sum + entry.count, 0);
  return [...head, { tool: `other (${tail.length})`, count: rest }];
}

export interface StatCard {
  key: "calls" | "denied" | "transformed" | "agents";
  label: string;
  value: number;
  hint: string;
}

export function statCards(stats: GuardStats): StatCard[] {
  return [
    {
      key: "calls",
      label: "Tool calls",
      value: stats.totalCalls,
      hint: "agent calls through the guard in this window",
    },
    {
      key: "denied",
      label: "Blocked",
      value: stats.denied,
      hint: "refused by policy before the tool ran",
    },
    {
      // `stats.transformed` counts calls whose payloads *contained* sensitive
      // classes (that is what storage counts) — not calls whose payloads were
      // rewritten. The label must say the true thing; the per-entry badge in
      // the log is the one that checks for an actual before/after difference.
      key: "transformed",
      label: "Sensitive data handled",
      value: stats.transformed,
      hint: "calls whose payloads contained sensitive data classes",
    },
    {
      key: "agents",
      label: "Unique agents",
      value: stats.uniqueAgents,
      hint: "distinct best-effort agent ids — advisory, spoofable",
    },
  ];
}

/** Nothing has happened in the window: the dashboard shows its empty state. */
export function isEmptyStats(stats: GuardStats): boolean {
  return stats.totalCalls === 0 && stats.byDay.length === 0 && stats.byTool.length === 0;
}

/**
 * Chart colours, validated against the dark chart surface (`#0f172a`) with the
 * data-viz palette checker: lightness band, chroma floor, CVD separation and
 * contrast all pass. Adjacent-pair CVD separation sits in the 6–8 band, which is
 * legal with secondary encoding — hence the always-on legend, the 2px gaps
 * between stacked segments, and the tooltip that names every series.
 *
 * The hues are the same story the verdict badges tell: allowed = green,
 * transformed = blue-cyan, denied = red.
 */
export const CHART_COLORS = {
  allowed: "#199e70",
  transformed: "#0e93cf",
  denied: "#e66767",
  /** Single-series bars (top tools) carry no identity, so one calm hue. */
  bar: "#3987e5",
  grid: "#1e293b",
  axis: "#64748b",
} as const;
