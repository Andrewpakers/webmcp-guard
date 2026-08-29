import { randomUUID } from "node:crypto";

import { LogRecordSchema, type LogRecord, type SessionContext } from "@webmcp-guard/shared";

import { getGuardServer, getGuardStorage } from "@/lib/guard/server";
import { REVEAL_FIELD_LABELS, type RevealableField } from "@/lib/mask";

/**
 * Human access events, written into the guard's own audit log.
 *
 * ⚠️ Server-only (it reaches the storage adapter, and therefore SQLite).
 *
 * `docs/05` § stretch: "each reveal is logged through the guard API as a human
 * access event". The guard's HTTP surface has no endpoint for *this* — `/gate`
 * and `/transform` describe an agent tool call, and pretending a person clicking
 * an eye icon is a gated tool call would put a fiction in the audit trail. So
 * the portal writes the entry itself, through the same `GuardStorage` the guard
 * server writes through, in the same table, with the same shape. The console
 * lists it, filters it and exports it without knowing it is special.
 *
 * What makes the entry honest:
 *
 * - `app` is the portal, not `webmcp-guard`: this happened in the host app.
 * - `tool` is {@link UI_REVEAL_TOOL}, which is *not* one of the seven registered
 *   WebMCP tools, so nothing conflates a human reveal with an agent call.
 * - `session` is the persona resolved from the signed cookie server-side — the
 *   same resolution the gate performs, never a value the page supplied.
 * - `agent` carries at most the raw `User-Agent` string and never an `agentId`:
 *   no agent identity is claimed for a click. (An actuating agent driving the
 *   revealed UI would look exactly like the human here. That residual gap is
 *   named in the README rather than papered over — the point of the log entry
 *   is that the access is *recorded*, not that its origin is proven.)
 * - the message names who, what and which patient, and **never the value**.
 */

/** The audit `app` a portal-side event is filed under — the host app's id. */
export const PORTAL_LOG_APP = "lakeside-portal";

/** The audit `tool` for a masked-field reveal in the portal UI. */
export const UI_REVEAL_TOOL = "ui_reveal_field";

/** How long a `User-Agent` header is allowed to be before it is truncated. */
const MAX_USER_AGENT = 256;

export interface FieldRevealAudit {
  /** The patient whose field was revealed, named by MRN. */
  mrn: string;
  field: RevealableField;
  /** Resolved server-side from the signed session cookie. */
  session: SessionContext;
  /** Display name of the persona that cookie resolved to. */
  actorName: string;
  /** The request's `User-Agent`, if it sent one. */
  userAgent?: string | null;
}

/**
 * The sentence an administrator reads in the console. Names the person, the
 * field and the patient; carries no part of the revealed value.
 */
export function fieldRevealMessage(event: FieldRevealAudit): string {
  return (
    `${event.actorName} (${event.session.role}) revealed the ${REVEAL_FIELD_LABELS[event.field]} ` +
    `of patient ${event.mrn} in the Lakeside portal UI. ` +
    "Masked-at-rest field, revealed by an explicit click; the value was not in the page before this."
  );
}

/**
 * Records one reveal and returns the stored entry.
 *
 * Callers must `await` this **before** answering with the value: a reveal that
 * could not be written down is a reveal that does not happen (the route turns a
 * throw here into a 500 and returns nothing).
 */
export async function logFieldReveal(event: FieldRevealAudit): Promise<LogRecord> {
  // Applies migrations and seeds the policy on first use, exactly as an
  // incoming `/api/guard/*` request would.
  await getGuardServer().ready();

  const userAgent = event.userAgent?.trim().slice(0, MAX_USER_AGENT);

  return getGuardStorage().appendLog(
    LogRecordSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      app: PORTAL_LOG_APP,
      tool: UI_REVEAL_TOOL,
      verdict: "allow",
      agent: userAgent ? { userAgent } : {},
      session: event.session,
      // The field name *is* the guard data class (`lib/mask.ts`), so the
      // console's per-class filters see human reveals alongside tool calls.
      dataClasses: [event.field],
      ruleIds: [],
      durationMs: 0,
      // Deliberately empty: an audit entry that copied the value it is auditing
      // would be a second place the value lives.
      payloads: {},
      message: fieldRevealMessage(event),
      status: "complete",
    } satisfies LogRecord),
  );
}
