"use client";

import type { GuardStats, LogRecord } from "@webmcp-guard/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useGuardClient } from "@/components/auth-provider";
import { CallsByVerdictChart, TopToolsChart } from "@/components/dashboard/charts";
import { EmptyState, ErrorNote, Panel, Spinner } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/api/client";
import { callsByDay, isEmptyStats, statCards, topTools } from "@/lib/dashboard/series";
import {
  VERDICT_BADGE,
  VERDICT_LABEL,
  agentLabel,
  displayVerdict,
  formatTimestamp,
} from "@/lib/logs/entry";
import { isoHoursAgo } from "@/lib/logs/query";

/**
 * Dashboard (`docs/06-console-requirements.md` §3): four stat cards over a
 * 24-hour window, calls-over-time stacked by verdict, top tools, and a recent
 * activity feed that links back into the audit log.
 */
export function DashboardView() {
  const client = useGuardClient();

  const [stats, setStats] = useState<GuardStats | null>(null);
  const [recent, setRecent] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    try {
      // Cards cover the last 24h; the feed is simply the newest 10 entries.
      const since = isoHoursAgo(24);
      const [nextStats, page] = await Promise.all([
        client.getStats({ since }),
        client.queryLogs({ limit: 10 }),
      ]);
      setStats(nextStats);
      setRecent(page.entries);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = useMemo(() => (stats === null ? [] : statCards(stats)), [stats]);
  const byDay = useMemo(() => (stats === null ? [] : callsByDay(stats)), [stats]);
  const byTool = useMemo(() => (stats === null ? [] : topTools(stats)), [stats]);
  const empty = stats !== null && isEmptyStats(stats);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Dashboard</h1>
          <p className="text-xs text-slate-400">Agent activity through this deployment, last 24 hours.</p>
        </div>
        <button type="button" className="gc-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error !== null && <ErrorNote message={error} onRetry={() => void load()} />}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.length === 0
          ? Array.from({ length: 4 }, (_unused, index) => (
              <div key={index} className="gc-card h-24 animate-pulse" />
            ))
          : cards.map((card) => (
              <div key={card.key} className="gc-card px-4 py-3">
                <p className="gc-label">{card.label}</p>
                <p className="mt-1 font-mono text-3xl leading-none text-slate-50 tabular-nums">
                  {card.value}
                </p>
                <p className="mt-1.5 text-[0.6875rem] text-slate-500">{card.hint}</p>
              </div>
            ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Calls over time" subtitle="Stacked by what the guard did with each call.">
          <div className="px-2 pt-3 pb-2">
            {stats === null ? (
              <Spinner label="Loading activity" />
            ) : byDay.length === 0 ? (
              <EmptyState title="No calls in this window">
                Drive a guarded tool in the portal and the day appears here.
              </EmptyState>
            ) : (
              <CallsByVerdictChart data={byDay} />
            )}
          </div>
        </Panel>

        <Panel title="Top tools" subtitle="Which tools the agents actually reach for.">
          <div className="px-2 pt-3 pb-2">
            {stats === null ? (
              <Spinner label="Loading tools" />
            ) : byTool.length === 0 ? (
              <EmptyState title="No tool calls yet">
                Every wrapped tool that runs shows up here, busiest first.
              </EmptyState>
            ) : (
              <TopToolsChart data={byTool} />
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title="Recent activity"
        subtitle="The last ten calls, newest first."
        actions={
          <Link href="/logs" className="gc-btn">
            Open audit log →
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyState title={empty ? "Nothing has called a guarded tool yet" : "No recent calls"}>
            Open the portal, run a tool from an agent, and the call appears here within seconds.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-900">
            {recent.map((entry) => {
              const verdict = displayVerdict(entry);
              const time = formatTimestamp(entry.timestamp);
              return (
                <li key={entry.id}>
                  <Link
                    href="/logs"
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs hover:bg-slate-800/40"
                  >
                    <span className="font-mono text-slate-500" title={time.full}>
                      {time.time}
                    </span>
                    <span className={`gc-badge ${VERDICT_BADGE[verdict]}`}>
                      {VERDICT_LABEL[verdict]}
                    </span>
                    <span className="font-mono text-slate-200">{entry.tool}</span>
                    <span className="text-slate-500">{agentLabel(entry.agent)}</span>
                    {entry.dataClasses.length > 0 && (
                      <span className="ml-auto flex flex-wrap gap-1">
                        {entry.dataClasses.map((dataClass) => (
                          <span key={dataClass} className="gc-chip">
                            {dataClass}
                          </span>
                        ))}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
