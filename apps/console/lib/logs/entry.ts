import type { LogRecord } from "@webmcp-guard/shared";

/**
 * Presentation helpers for one audit entry. The log's stored `verdict` is the
 * gate vocabulary (`allow | deny | require-confirmation | require-justification`);
 * the console additionally shows **transformed**, which is not a verdict but a
 * derived fact — an allowed call whose payload the data controls actually
 * touched (decision of record from the Phase 2 work log).
 */

export const DISPLAY_VERDICTS = [
  "allowed",
  "transformed",
  "denied",
  "confirmed",
  "justified",
] as const;

export type DisplayVerdict = (typeof DISPLAY_VERDICTS)[number];

/**
 * `transformed` requires evidence the payload actually changed — a byte-level
 * difference between what the tool produced and what the agent received (or
 * between the args as sent and as executed, for inbound detokenization).
 * `dataClasses` alone is NOT that evidence: the classifier records classes it
 * *found* even when policy passed every one of them through untouched.
 */
export function payloadChanged(entry: Pick<LogRecord, "payloads">): boolean {
  const p = entry.payloads;
  if (p === undefined) return false;
  const changed = (before: unknown, after: unknown): boolean =>
    before !== undefined && after !== undefined
      ? JSON.stringify(before) !== JSON.stringify(after)
      : false;
  return changed(p.resultBefore, p.resultAfter) || changed(p.argsBefore, p.argsAfter);
}

export function displayVerdict(
  entry: Pick<LogRecord, "verdict" | "dataClasses" | "payloads">,
): DisplayVerdict {
  switch (entry.verdict) {
    case "deny":
      return "denied";
    case "require-confirmation":
      return "confirmed";
    case "require-justification":
      return "justified";
    case "allow":
    default:
      return payloadChanged(entry) ? "transformed" : "allowed";
  }
}

export const VERDICT_LABEL: Record<DisplayVerdict, string> = {
  allowed: "allowed",
  transformed: "transformed",
  denied: "denied",
  confirmed: "confirmation",
  justified: "justification",
};

/**
 * Tailwind classes per verdict badge: allow = emerald, deny = red,
 * require-* = amber, transformed = cyan (`docs/06`, and the same hues the
 * dashboard charts use).
 */
export const VERDICT_BADGE: Record<DisplayVerdict, string> = {
  allowed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  transformed: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  denied: "border-red-500/30 bg-red-500/10 text-red-300",
  confirmed: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  justified: "border-amber-500/30 bg-amber-500/10 text-amber-300",
};

/**
 * Best-effort agent identity, exactly as reported — never presented as proven
 * (`docs/03-architecture.md` threat model: these signals are spoofable).
 */
export function agentLabel(agent: LogRecord["agent"]): string {
  const browser =
    agent.browserBrand === undefined
      ? undefined
      : agent.browserVersion === undefined
        ? agent.browserBrand
        : `${agent.browserBrand} ${agent.browserVersion}`;

  if (agent.agentId !== undefined && agent.agentId.length > 0) {
    return browser === undefined ? agent.agentId : `${agent.agentId} · ${browser}`;
  }
  return browser ?? "unidentified";
}

/** `2026-08-29T18:04:05.123Z` → `18:04:05` / `Aug 29` for the dense table. */
export function formatTimestamp(iso: string): { time: string; date: string; full: string } {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return { time: iso, date: "", full: iso };
  return {
    time: parsed.toLocaleTimeString(undefined, { hour12: false }),
    date: parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    full: parsed.toISOString(),
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Phase 5 writes a justification and an evaluator verdict onto the log entry.
 * They are not in `LogEntrySchema` yet (only `justification` is), so this reads
 * them defensively and the drawer renders the section only when something is
 * there — no schema change required on either side to light it up.
 */
export interface JustificationView {
  text?: string;
  verdict?: string;
  reason?: string;
}

export function readJustification(entry: unknown): JustificationView | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;

  const view: JustificationView = {};
  if (typeof record.justification === "string" && record.justification.trim().length > 0) {
    view.text = record.justification;
  }

  const evaluation = record.justificationVerdict ?? record.evaluator ?? record.evaluation;
  if (typeof evaluation === "string" && evaluation.length > 0) {
    view.verdict = evaluation;
  } else if (typeof evaluation === "object" && evaluation !== null) {
    const { verdict, reason } = evaluation as { verdict?: unknown; reason?: unknown };
    if (typeof verdict === "string" && verdict.length > 0) view.verdict = verdict;
    if (typeof reason === "string" && reason.length > 0) view.reason = reason;
  }

  return view.text === undefined && view.verdict === undefined && view.reason === undefined
    ? null
    : view;
}
