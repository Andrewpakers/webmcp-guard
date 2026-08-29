"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDate } from "@/lib/format";
import { REVEAL_FIELD_LABELS, type RevealableField } from "@/lib/mask";
import { revealPatientField } from "@/lib/reveal";

/**
 * A field that is masked in the DOM until someone asks for it
 * (`docs/05` § stretch, `docs/03` threat model mitigation (1)).
 *
 * The component is handed a **mask string**, never the value: the server
 * computed the mask in `lib/mask.ts` and kept the value. Clicking the eye posts
 * to `/api/portal/reveal-field`, which writes a human access event into the
 * guard's audit log and then answers with the value. Clicking it again drops the
 * value from state, so the next look is a new request and a new log entry.
 *
 * Nothing here is a security boundary against the person at the keyboard — they
 * can click. It is a boundary against *scraping*: an agent that reads this page
 * instead of calling the guarded tools finds bullets, and any route to the real
 * value goes through a call that is written down.
 */

export interface MaskedFieldProps {
  /** Patient id or MRN — whatever the page already holds. */
  patientId: string;
  field: RevealableField;
  /** Pre-computed by `maskAtRest()` on the server. The only value in the DOM. */
  mask: string;
  /** Wrapper classes, so a chart header and a definition list can differ. */
  className?: string;
  /** Classes for the value/mask text itself (e.g. `font-mono`). */
  valueClassName?: string;
  /**
   * How to render the revealed value. `"date"` runs the stored `YYYY-MM-DD`
   * through the portal's usual date format. A formatter *function* cannot be a
   * prop here — this is a client component, and props cross the boundary as
   * JSON.
   */
  formatAs?: "date";
}

export function MaskedField({
  patientId,
  field,
  mask,
  className = "",
  valueClassName = "",
  formatAs,
}: MaskedFieldProps) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives the fade-out highlight that draws the eye to what just changed.
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const label = REVEAL_FIELD_LABELS[field];
  const revealed = value !== null;

  const toggle = useCallback(async () => {
    if (revealed) {
      // Forget it. Re-revealing costs another request, which is another audit
      // entry — that is deliberate, not an oversight.
      setValue(null);
      setError(null);
      setFlash(false);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const next = await revealPatientField(patientId, field);
      setValue(next);
      setFlash(true);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 1600);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reveal this field.");
    } finally {
      setBusy(false);
    }
  }, [field, patientId, revealed]);

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        data-testid={`masked-value-${field}`}
        aria-live="polite"
        className={`rounded px-1 transition-colors duration-700 ${
          flash ? "bg-amber-100" : "bg-transparent"
        } ${revealed ? "" : "tracking-wider text-slate-500 select-none"} ${valueClassName}`}
      >
        {value === null ? mask : formatAs === "date" ? formatDate(value) : value}
      </span>

      <button
        type="button"
        data-testid={`masked-toggle-${field}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={revealed}
        aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
        title={
          revealed
            ? `Hide ${label}`
            : `Reveal ${label} — this access is recorded in the WebMCP Guard audit log`
        }
        className={`rounded-sm p-0.5 text-slate-400 transition-colors hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-40 ${
          busy ? "animate-pulse" : ""
        }`}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </button>

      {error === null ? null : (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

/** 14px line icons, inline so the portal ships no icon dependency. */
function EyeIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.2 8S3.7 3.4 8 3.4 14.8 8 14.8 8 12.3 12.6 8 12.6 1.2 8 1.2 8Z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.3 3.7A6.7 6.7 0 0 1 8 3.4C12.3 3.4 14.8 8 14.8 8a12 12 0 0 1-2.2 2.7M4.1 4.7A12 12 0 0 0 1.2 8S3.7 12.6 8 12.6c1 0 1.9-.2 2.7-.6" />
      <path d="M6.6 6.6a2.1 2.1 0 0 0 2.9 2.9" />
      <path d="m2.4 2.4 11.2 11.2" />
    </svg>
  );
}
