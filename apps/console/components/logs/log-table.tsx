"use client";

import type { LogRecord } from "@webmcp-guard/shared";

import { EmptyState } from "@/components/ui/primitives";
import {
  VERDICT_BADGE,
  VERDICT_LABEL,
  agentLabel,
  displayVerdict,
  formatDuration,
  formatTimestamp,
} from "@/lib/logs/entry";

/**
 * The audit table: reverse-chronological, dense, one row per agent tool call
 * (`docs/06-console-requirements.md` §1). Every row opens the detail drawer.
 */
export function LogTable({
  entries,
  selectedId,
  onSelect,
}: {
  entries: LogRecord[];
  selectedId: string | null;
  onSelect: (entry: LogRecord) => void;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState title="No tool calls match these filters">
        Every agent call through <span className="font-mono">document.modelContext</span> lands here
        the moment it happens. Clear the filters, or drive a tool in the portal to see one arrive.
      </EmptyState>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[64rem] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-slate-500">
            <Th className="w-36">Time</Th>
            <Th className="w-28">App</Th>
            <Th className="w-44">Tool</Th>
            <Th className="w-52">Agent</Th>
            <Th className="w-28">Verdict</Th>
            <Th>Data classes</Th>
            <Th className="w-44">Rules</Th>
            <Th className="w-20 text-right">Duration</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const verdict = displayVerdict(entry);
            const time = formatTimestamp(entry.timestamp);
            const selected = entry.id === selectedId;

            return (
              <tr
                key={entry.id}
                onClick={() => onSelect(entry)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(entry);
                  }
                }}
                className={`cursor-pointer border-b border-slate-900 transition-colors hover:bg-slate-800/40 focus-visible:bg-slate-800/60 focus-visible:outline-none ${
                  selected ? "bg-indigo-950/40" : ""
                }`}
              >
                <Td className="whitespace-nowrap">
                  <span className="font-mono text-slate-300" title={time.full}>
                    {time.time}
                  </span>
                  <span className="ml-1.5 text-slate-600">{time.date}</span>
                  {entry.status === "pending" && (
                    <span
                      className="ml-1.5 text-amber-400"
                      title="Gated and still running — the transform half has not landed yet"
                    >
                      •
                    </span>
                  )}
                </Td>
                <Td className="text-slate-400">{entry.app}</Td>
                <Td>
                  <span className="font-mono text-slate-200">{entry.tool}</span>
                </Td>
                <Td className="text-slate-400" title="Best-effort and spoofable — advisory only">
                  {agentLabel(entry.agent)}
                </Td>
                <Td>
                  <span className={`gc-badge ${VERDICT_BADGE[verdict]}`}>
                    {VERDICT_LABEL[verdict]}
                  </span>
                </Td>
                <Td>
                  {entry.dataClasses.length === 0 ? (
                    <span className="text-slate-700">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {entry.dataClasses.map((dataClass) => (
                        <span key={dataClass} className="gc-chip">
                          {dataClass}
                        </span>
                      ))}
                    </span>
                  )}
                </Td>
                <Td>
                  {entry.ruleIds.length === 0 ? (
                    <span className="text-slate-700">default</span>
                  ) : (
                    <span className="font-mono text-[0.6875rem] text-slate-400">
                      {entry.ruleIds.join(", ")}
                    </span>
                  )}
                </Td>
                <Td className="text-right font-mono text-slate-400">
                  {formatDuration(entry.durationMs)}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-[0.6875rem] font-medium tracking-wide uppercase ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "", title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <td className={`px-3 py-1.5 align-top ${className}`} title={title}>
      {children}
    </td>
  );
}
