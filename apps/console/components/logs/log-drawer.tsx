"use client";

import type { LogRecord } from "@webmcp-guard/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useGuardClient } from "@/components/auth-provider";
import {
  VERDICT_BADGE,
  VERDICT_LABEL,
  agentLabel,
  displayVerdict,
  formatDuration,
  readJustification,
} from "@/lib/logs/entry";
import { formatJson, isEmptyPayload, payloadView } from "@/lib/logs/mask";

/**
 * Detail drawer for one audit entry (`docs/06-console-requirements.md` §1):
 * matched rules linking into the policy editor, the posture snapshot as
 * reported, before/after payloads with the originals masked until revealed, and
 * the justification + evaluator verdict once Phase 5 writes them.
 */
export function LogDrawer({ entry, onClose }: { entry: LogRecord; onClose: () => void }) {
  const client = useGuardClient();
  const [revealed, setRevealed] = useState(false);
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  // A different row is a different secret: re-mask on every change.
  useEffect(() => {
    setRevealed(false);
    setRevealNote(null);
  }, [entry.id]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function reveal() {
    if (client === null) return;
    setRevealing(true);
    // Reveals are an audited admin action; the payload is shown either way, and
    // the operator is told when the deployment could not record it.
    const result = await client.revealLog(entry.id);
    setRevealing(false);
    setRevealed(true);
    setRevealNote(result.logged ? null : (result.reason ?? "The reveal was not audited."));
  }

  const verdict = displayVerdict(entry);
  const justification = readJustification(entry);
  const posture = {
    agent: entry.agent,
    ...(entry.session === undefined ? {} : { session: entry.session }),
  };

  return (
    <aside
      role="dialog"
      aria-label={`Audit entry for ${entry.tool}`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-slate-800 bg-slate-950/95 shadow-2xl backdrop-blur"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`gc-badge ${VERDICT_BADGE[verdict]}`}>{VERDICT_LABEL[verdict]}</span>
            <h2 className="font-mono text-sm text-slate-100">{entry.tool}</h2>
          </div>
          <p className="mt-1 font-mono text-[0.6875rem] text-slate-500">
            {entry.id} · {entry.timestamp}
          </p>
        </div>
        <button type="button" className="gc-btn" onClick={onClose} aria-label="Close details">
          Close
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {entry.message !== undefined && (
          <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs leading-relaxed text-slate-300">
            {entry.message}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <Detail label="App">{entry.app}</Detail>
          <Detail label="Duration">{formatDuration(entry.durationMs)}</Detail>
          <Detail label="Status">{entry.status}</Detail>
          <Detail label="Agent">{agentLabel(entry.agent)}</Detail>
          <Detail label="Role">{entry.session?.role ?? "—"}</Detail>
          <Detail label="User">{entry.session?.userId ?? "—"}</Detail>
        </dl>

        <Section title="Matched rules">
          {entry.ruleIds.length === 0 ? (
            <p className="text-xs text-slate-500">
              No rule matched — the policy default decided this call.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {entry.ruleIds.map((ruleId) => (
                <li key={ruleId}>
                  <Link href={`/policies#${ruleId}`} className="gc-chip gc-link no-underline">
                    {ruleId} →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Posture snapshot"
          hint="As reported by the page — best-effort and spoofable, never proof of identity."
        >
          <pre className="gc-json">{formatJson(posture)}</pre>
        </Section>

        {justification !== null && (
          <Section title="Justification">
            {justification.text !== undefined && (
              <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs leading-relaxed text-slate-200">
                {justification.text}
              </p>
            )}
            {(justification.verdict !== undefined || justification.reason !== undefined) && (
              <p className="mt-2 text-xs text-slate-400">
                <span className="gc-label">evaluator</span>{" "}
                <span className="font-mono text-slate-200">{justification.verdict ?? "—"}</span>
                {justification.reason !== undefined && ` — ${justification.reason}`}
              </p>
            )}
          </Section>
        )}

        <Section
          title="Payloads"
          hint="Left column: what the site actually handled. Right column: what the agent saw."
          actions={
            revealed ? (
              <span className="text-[0.6875rem] text-amber-300">originals revealed</span>
            ) : (
              <button type="button" className="gc-btn" onClick={reveal} disabled={revealing}>
                {revealing ? "Revealing…" : "Reveal original"}
              </button>
            )
          }
        >
          {revealNote !== null && (
            <p className="mb-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[0.6875rem] text-amber-200">
              {revealNote}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Payload
              title="Args — original"
              sensitive
              revealed={revealed}
              value={entry.payloads.argsBefore}
            />
            <Payload
              title="Args — as executed"
              sensitive={false}
              revealed={revealed}
              value={entry.payloads.argsAfter}
            />
            <Payload
              title="Result — original"
              sensitive
              revealed={revealed}
              value={entry.payloads.resultBefore}
            />
            <Payload
              title="Result — returned to agent"
              sensitive={false}
              revealed={revealed}
              value={entry.payloads.resultAfter}
            />
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="gc-label">{label}</dt>
      <dd className="mt-0.5 truncate text-slate-200" title={String(children)}>
        {children}
      </dd>
    </div>
  );
}

function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-slate-200">{title}</h3>
          {hint !== undefined && <p className="text-[0.6875rem] text-slate-500">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Payload({
  title,
  value,
  sensitive,
  revealed,
}: {
  title: string;
  value: unknown;
  sensitive: boolean;
  revealed: boolean;
}) {
  const masked = sensitive && !revealed;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-[0.6875rem] text-slate-400">
        {title}
        {masked && <span className="gc-chip border-amber-900/60 text-amber-300">masked</span>}
      </p>
      {isEmptyPayload(value) ? (
        <p className="gc-json text-slate-600">— nothing recorded —</p>
      ) : (
        <pre className="gc-json">{payloadView(value, { sensitive, revealed })}</pre>
      )}
    </div>
  );
}
