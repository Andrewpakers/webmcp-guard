"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Toggle } from "@/components/ui/primitives";
import {
  DATA_CLASS_OPTIONS,
  EMPTY_LOG_FILTERS,
  VERDICT_OPTIONS,
  hasActiveFilters,
  type LogFilterState,
} from "@/lib/logs/query";

/**
 * The filter bar from `docs/06-console-requirements.md` §1: tool, verdict, data
 * class, agent, time range, plus the auto-refresh switch (polling — no
 * websockets, by design).
 *
 * Selects apply on change; text and time inputs apply on submit, so typing a
 * tool name does not fire a request per keystroke.
 */
export function LogFilters({
  value,
  onChange,
  autoRefresh,
  onAutoRefreshChange,
  onRefresh,
  busy,
}: {
  value: LogFilterState;
  onChange: (next: LogFilterState) => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (next: boolean) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<LogFilterState>(value);

  // Keep the draft in step when the parent resets the filters.
  useEffect(() => setDraft(value), [value]);

  function apply(next: LogFilterState) {
    setDraft(next);
    onChange(next);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    onChange(draft);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="gc-card flex flex-wrap items-end gap-x-3 gap-y-2.5 px-3 py-2.5"
    >
      <Field label="Tool">
        <input
          className="gc-input w-40"
          placeholder="search_patients"
          value={draft.tool}
          onChange={(event) => setDraft({ ...draft, tool: event.target.value })}
        />
      </Field>

      <Field label="Verdict">
        <select
          className="gc-input w-40"
          value={draft.verdict}
          onChange={(event) =>
            apply({ ...draft, verdict: event.target.value as LogFilterState["verdict"] })
          }
        >
          <option value="">any verdict</option>
          {VERDICT_OPTIONS.map((verdict) => (
            <option key={verdict} value={verdict}>
              {verdict}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Data class">
        <select
          className="gc-input w-40"
          value={draft.dataClass}
          onChange={(event) =>
            apply({ ...draft, dataClass: event.target.value as LogFilterState["dataClass"] })
          }
        >
          <option value="">any class</option>
          {DATA_CLASS_OPTIONS.map((dataClass) => (
            <option key={dataClass} value={dataClass}>
              {dataClass}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Agent">
        <input
          className="gc-input w-36"
          placeholder="chatgpt-atlas"
          value={draft.agent}
          onChange={(event) => setDraft({ ...draft, agent: event.target.value })}
        />
      </Field>

      <Field label="Since">
        <input
          type="datetime-local"
          className="gc-input w-52"
          value={draft.since}
          onChange={(event) => setDraft({ ...draft, since: event.target.value })}
        />
      </Field>

      <Field label="Until">
        <input
          type="datetime-local"
          className="gc-input w-52"
          value={draft.until}
          onChange={(event) => setDraft({ ...draft, until: event.target.value })}
        />
      </Field>

      <div className="flex items-center gap-2">
        <button type="submit" className="gc-btn gc-btn-primary">
          Apply
        </button>
        {hasActiveFilters(value) && (
          <button type="button" className="gc-btn" onClick={() => apply(EMPTY_LOG_FILTERS)}>
            Clear
          </button>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <button type="button" className="gc-btn" onClick={onRefresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <Toggle
            checked={autoRefresh}
            onChange={onAutoRefreshChange}
            label="Auto-refresh every 5 seconds"
          />
          auto-refresh <span className="text-slate-600">5s</span>
        </label>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="gc-label">{label}</span>
      {children}
    </label>
  );
}
