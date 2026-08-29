"use client";

import type { GuardEvent } from "@webmcp-guard/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  ACTIVITY_FOOTER,
  type ActivityTone,
  EMPTY_ACTIVITY_MESSAGE,
  badgeLabel,
  badgeTone,
  eventDetail,
  eventKey,
  formatEventTime,
  newestFirst,
} from "@/lib/webmcp/activity";
import { GUARD_ENDPOINT, getGuard } from "@/lib/webmcp/guard";

/**
 * The Agent Activity drawer (docs/05).
 *
 * A dock on the right edge that streams WebMCP Guard's pipeline events for the
 * current page: every gate verdict, every execution, every transformed result,
 * every block. It makes the invisible layer visible — which is the whole point
 * of the demo — and it deliberately does **not** dim the page behind it, so a
 * viewer can watch the patient list change while the agent works.
 *
 * Events come from the SDK's in-page ring buffer (`recentEvents()` for history,
 * `subscribe()` for the live feed), so a drawer opened halfway through a
 * conversation still shows what already happened.
 */

/** Client-side cap. The SDK keeps 50; this only bounds a very long session. */
const MAX_EVENTS = 200;

const BADGE_TONES: Record<ActivityTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  neutral: "border-slate-200 bg-slate-100 text-slate-600",
};

const RAIL_TONES: Record<ActivityTone, string> = {
  ok: "bg-emerald-400",
  danger: "bg-rose-400",
  neutral: "bg-slate-300",
};

export function AgentActivityDrawer() {
  const [events, setEvents] = useState<GuardEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // The panel is portalled to <body>: the header it is declared in sets
  // `backdrop-blur`, and a backdrop-filter makes an element the containing block
  // for its fixed-position descendants — the drawer would be trapped inside the
  // 56px header instead of spanning the viewport.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    // Resolved inside the effect on purpose: the guard is a browser object and
    // this component also renders on the server.
    let cancelled = false;
    const guard = getGuard();
    setEvents(guard.recentEvents().slice(-MAX_EVENTS));

    const unsubscribe = guard.subscribe((event) => {
      if (cancelled) return;
      setEvents((previous) => [...previous, event].slice(-MAX_EVENTS));
      // A block is the beat worth interrupting for: show the human why the
      // agent just got told no, without them having to go looking.
      if (event.type === "blocked") setOpen(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Newest events render at the top, so "follow the feed" means scroll to top.
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [events.length, open]);

  const toggle = useCallback(() => setOpen((previous) => !previous), []);

  const rows = newestFirst(events);
  const hasProblem = events.some((event) => event.type === "blocked" || event.type === "error");

  const panel = (
    <aside
      id="agent-activity-panel"
      aria-label="Agent activity"
      aria-hidden={!open}
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Agent activity</h2>
          <p className="text-[11px] text-slate-500">
            {events.length} {events.length === 1 ? "event" : "events"} this session
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50"
        >
          Close
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
            {EMPTY_ACTIVITY_MESSAGE}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((event, index) => (
              <ActivityRow key={eventKey(event, rows.length - index)} event={event} />
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500">
        <span className="font-medium text-slate-600">{ACTIVITY_FOOTER}</span>
        <span className="text-slate-400"> · {GUARD_ENDPOINT}</span>
      </footer>
    </aside>
  );

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="agent-activity-panel"
        title="Live WebMCP Guard events for this page."
        className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        Agent activity
        <span
          className={`inline-flex min-w-5 justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
            events.length === 0
              ? "bg-slate-100 text-slate-500"
              : hasProblem
                ? "bg-rose-100 text-rose-700"
                : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {events.length}
        </span>
      </button>

      {mounted ? createPortal(panel, document.body) : null}
    </>
  );
}

function ActivityRow({ event }: { event: GuardEvent }) {
  const tone = badgeTone(event);
  const label = badgeLabel(event);
  // The badge already says the stage for everything but a gate verdict; showing
  // "BLOCKED · BLOCKED" would just be noise.
  const stage = label === event.type ? null : event.type;

  return (
    <li className="flex gap-3 px-4 py-2.5">
      <span className={`mt-1 w-0.5 shrink-0 rounded-full ${RAIL_TONES[tone]}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-xs font-medium text-slate-800">
            {event.tool}
          </span>
          <time className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
            {formatEventTime(event.at)}
          </time>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BADGE_TONES[tone]}`}
          >
            {label}
          </span>
          {stage === null ? null : (
            <span className="text-[10px] uppercase tracking-wide text-slate-400">{stage}</span>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-slate-600">{eventDetail(event)}</p>
      </div>
    </li>
  );
}
