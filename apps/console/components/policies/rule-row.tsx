"use client";

import type { Rule } from "@webmcp-guard/shared";
import { useState } from "react";

import { Toggle } from "@/components/ui/primitives";
import { ACTION_LABEL } from "@/lib/policy/rule-form";
import { ACTION_BADGE, summarizeAction, summarizeMatch } from "@/lib/policy/summary";

/**
 * One rule in the ordered list: its position controls, the enable switch, a
 * readable summary of WHEN/THEN, and the edit/delete affordances. The audit
 * log's "matched rules" links land on this row via `#<ruleId>`.
 */
export function RuleRow({
  rule,
  index,
  count,
  busy,
  highlighted,
  editing,
  onMove,
  onToggle,
  onEdit,
  onDelete,
  children,
}: {
  rule: Rule;
  index: number;
  count: number;
  busy: boolean;
  highlighted: boolean;
  editing: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      id={rule.id}
      className={`gc-card scroll-mt-28 transition-colors ${
        highlighted ? "border-indigo-500/70 ring-1 ring-indigo-500/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-start gap-3 px-3 py-2.5">
        <div className="flex flex-col items-center gap-0.5 pt-0.5">
          <button
            type="button"
            className="gc-btn px-1.5 py-0.5"
            aria-label={`Move ${rule.name} earlier`}
            disabled={index === 0 || busy}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <span className="font-mono text-[0.625rem] text-slate-600" title="priority">
            {rule.priority}
          </span>
          <button
            type="button"
            className="gc-btn px-1.5 py-0.5"
            aria-label={`Move ${rule.name} later`}
            disabled={index === count - 1 || busy}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-slate-100">{rule.name}</h3>
            <span className={`gc-badge ${ACTION_BADGE[rule.action.type]}`}>
              {ACTION_LABEL[rule.action.type]}
            </span>
            {!rule.enabled && (
              <span
                className="gc-badge border-slate-600/50 bg-slate-700/30 text-slate-400"
                title="This rule is fully editable — it just isn't enforced until the toggle is on."
              >
                off — not enforced
              </span>
            )}
            <span className="font-mono text-[0.6875rem] text-slate-500">{rule.id}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            {summarizeMatch(rule.match).map((facet) => (
              <span key={facet.label}>
                <span className="gc-label">{facet.label}</span>{" "}
                <span className="font-mono text-[0.6875rem] text-slate-300">{facet.value}</span>
              </span>
            ))}
          </div>

          <p className="mt-1 text-xs text-slate-400">
            <span className="gc-label">then</span>{" "}
            <span className="text-slate-300">{summarizeAction(rule.action)}</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Toggle
            checked={rule.enabled}
            onChange={onToggle}
            disabled={busy}
            label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
          />
          <button type="button" className="gc-btn" onClick={onEdit} disabled={busy}>
            {editing ? "Close" : "Edit"}
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className="gc-btn gc-btn-danger"
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
                disabled={busy}
              >
                Confirm delete
              </button>
              <button type="button" className="gc-btn" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="gc-btn gc-btn-danger"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {children}
    </li>
  );
}
