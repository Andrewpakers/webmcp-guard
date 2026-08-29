"use client";

import type { LogRecord } from "@webmcp-guard/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useGuardClient } from "@/components/auth-provider";
import { LogDrawer } from "@/components/logs/log-drawer";
import { LogFilters } from "@/components/logs/log-filters";
import { LogTable } from "@/components/logs/log-table";
import { ErrorNote, Panel, Spinner } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/api/client";
import {
  EMPTY_LOG_FILTERS,
  LOG_PAGE_SIZE,
  logFiltersToQuery,
  pageRange,
  type LogFilterState,
} from "@/lib/logs/query";

/** How often the log polls while auto-refresh is on (docs/06: no websockets). */
const REFRESH_MS = 5000;

export function LogsView() {
  const client = useGuardClient();

  const [filters, setFilters] = useState<LogFilterState>(EMPTY_LOG_FILTERS);
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useMemo(
    () => logFiltersToQuery(filters, { limit: LOG_PAGE_SIZE, offset }),
    [filters, offset],
  );

  // The in-flight request, so a fast filter change or a poll landing late can
  // never overwrite fresher results.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (mode: "initial" | "poll") => {
      if (client === null) return;

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      if (mode === "initial") setLoading(true);
      else setRefreshing(true);

      try {
        const page = await client.queryLogs(query, controller.signal);
        if (controller.signal.aborted) return;
        setEntries(page.entries);
        setTotal(page.total);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, query],
  );

  useEffect(() => {
    void load("initial");
    return () => inFlight.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load("poll"), REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  // Follow the selected row across refreshes, so a pending call completing in
  // the background updates the open drawer instead of freezing it.
  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const [first, last] = pageRange(offset, entries.length, total);
  const hasPrevious = offset > 0;
  const hasNext = offset + entries.length < total;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Audit log</h1>
          <p className="text-xs text-slate-400">
            Every agent tool call through WebMCP Guard: what was asked, which rules fired, and what
            the agent actually received.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          {total === 0 ? "no entries" : `showing ${first}–${last} of ${total}`}
        </p>
      </div>

      <LogFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setOffset(0);
        }}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onRefresh={() => void load("poll")}
        busy={refreshing || loading}
      />

      {error !== null && <ErrorNote message={error} onRetry={() => void load("initial")} />}

      <Panel>
        {loading && entries.length === 0 ? (
          <Spinner label="Loading audit entries" />
        ) : (
          <LogTable
            entries={entries}
            selectedId={selectedId}
            onSelect={(entry) => setSelectedId(entry.id)}
          />
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
          <span>
            {refreshing ? "refreshing…" : autoRefresh ? "auto-refreshing every 5s" : "paused"}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="gc-btn"
              disabled={!hasPrevious}
              onClick={() => setOffset(Math.max(0, offset - LOG_PAGE_SIZE))}
            >
              ← Newer
            </button>
            <button
              type="button"
              className="gc-btn"
              disabled={!hasNext}
              onClick={() => setOffset(offset + LOG_PAGE_SIZE)}
            >
              Older →
            </button>
          </span>
        </footer>
      </Panel>

      {selected !== null && <LogDrawer entry={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
