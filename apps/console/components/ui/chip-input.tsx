"use client";

import { useState, type KeyboardEvent } from "react";

import { addChip, removeChip } from "@/lib/policy/rule-form";

/**
 * Chip editor for the rule builder's list matchers (apps, tool names, tool
 * tags, roles). Enter or comma commits; backspace on an empty box removes the
 * last chip. All the list logic lives in `lib/policy/rule-form`.
 */
export function ChipInput({
  values,
  onChange,
  placeholder,
  label,
  disabled = false,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function commit(text: string) {
    const next = addChip(values, text);
    if (next.length !== values.length) onChange(next);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft.length === 0 && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1.5 focus-within:border-indigo-500 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      {values.map((value) => (
        <span key={value} className="gc-chip">
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            className="cursor-pointer text-slate-500 hover:text-red-300"
            onClick={() => onChange(removeChip(values, value))}
            disabled={disabled}
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        className="min-w-32 flex-1 bg-transparent py-0.5 text-sm text-slate-100 outline-none placeholder:text-slate-600"
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
