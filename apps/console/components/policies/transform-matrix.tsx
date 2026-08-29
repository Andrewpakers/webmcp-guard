"use client";

import type { DataClass, PerClassTransform, TransformAction } from "@webmcp-guard/shared";

import {
  DATA_CLASS_REFERENCE,
  TRANSFORM_ACTION_HINT,
  TRANSFORM_ACTION_ORDER,
} from "@/lib/settings/reference";

/**
 * The per-class transform matrix — the visual centrepiece of the policy editor
 * (`docs/06-console-requirements.md` §2). Rows are the ten data classes in the
 * shared enum's order; columns are tokenize / mask / contextualize /
 * passthrough. One radio per cell, so the whole outbound data policy for a rule
 * is legible in a single glance.
 */

const COLUMN_TINT: Record<TransformAction, string> = {
  tokenize: "peer-checked:border-cyan-400/70 peer-checked:bg-cyan-500/20 peer-checked:text-cyan-200",
  mask: "peer-checked:border-indigo-400/70 peer-checked:bg-indigo-500/20 peer-checked:text-indigo-200",
  contextualize:
    "peer-checked:border-amber-400/70 peer-checked:bg-amber-500/20 peer-checked:text-amber-200",
  passthrough:
    "peer-checked:border-slate-500 peer-checked:bg-slate-700/60 peer-checked:text-slate-200",
};

export function TransformMatrix({
  value,
  onChange,
  disabled = false,
}: {
  value: PerClassTransform;
  onChange: (next: PerClassTransform) => void;
  disabled?: boolean;
}) {
  function set(dataClass: DataClass, action: TransformAction) {
    onChange({ ...value, [dataClass]: action });
  }

  function setColumn(action: TransformAction) {
    const next = { ...value };
    for (const entry of DATA_CLASS_REFERENCE) next[entry.dataClass] = action;
    onChange(next);
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-800">
      <table className="w-full min-w-[38rem] border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/60">
            <th scope="col" className="px-3 py-2 text-left">
              <span className="gc-label">Data class</span>
            </th>
            {TRANSFORM_ACTION_ORDER.map((action) => (
              <th key={action} scope="col" className="px-2 py-1.5 text-center">
                <button
                  type="button"
                  className="gc-label cursor-pointer hover:text-slate-200"
                  title={`${TRANSFORM_ACTION_HINT[action]} (click to apply to every class)`}
                  onClick={() => setColumn(action)}
                  disabled={disabled}
                >
                  {action}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DATA_CLASS_REFERENCE.map((entry) => (
            <tr key={entry.dataClass} className="border-b border-slate-900 last:border-0 hover:bg-slate-800/30">
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                <span className="font-mono text-slate-200">{entry.dataClass}</span>
                <span className="ml-2 text-slate-500">{entry.label}</span>
              </th>
              {TRANSFORM_ACTION_ORDER.map((action) => {
                const id = `perClass-${entry.dataClass}-${action}`;
                return (
                  <td key={action} className="px-2 py-1 text-center">
                    <input
                      id={id}
                      type="radio"
                      className="peer sr-only"
                      name={`perClass-${entry.dataClass}`}
                      value={action}
                      checked={value[entry.dataClass] === action}
                      disabled={disabled}
                      onChange={() => set(entry.dataClass, action)}
                    />
                    <label
                      htmlFor={id}
                      title={TRANSFORM_ACTION_HINT[action]}
                      className={`block cursor-pointer rounded border border-slate-800 bg-slate-950/40 px-2 py-1 text-[0.6875rem] text-slate-600 transition-colors hover:border-slate-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 ${COLUMN_TINT[action]}`}
                    >
                      {value[entry.dataClass] === action ? "●" : "○"}
                    </label>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
