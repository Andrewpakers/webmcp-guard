"use client";

import type { ReactNode } from "react";

/** Small presentational pieces shared by every console surface. */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`gc-card ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
          <div>
            {title !== undefined && (
              <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
            )}
            {subtitle !== undefined && (
              <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {children !== undefined && (
        <div className="max-w-md text-xs leading-relaxed text-slate-500">{children}</div>
      )}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
      <span>{message}</span>
      {onRetry !== undefined && (
        <button type="button" className="gc-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[0.6875rem] ${className}`}>{children}</span>;
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "border-emerald-500/50 bg-emerald-600/70" : "border-slate-700 bg-slate-800"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-slate-100 transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-xs text-slate-500">
      <span
        aria-hidden
        className="h-3 w-3 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400"
      />
      {label}…
    </div>
  );
}

/** A dot that says whether the console is talking to the portal right now. */
export function StatusDot({ state }: { state: "ok" | "error" | "idle" }) {
  const color =
    state === "ok" ? "bg-emerald-400" : state === "error" ? "bg-red-400" : "bg-slate-500";
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}
