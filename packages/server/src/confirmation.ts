import { createHash } from "node:crypto";

import type { ConfirmationEntry, JsonObject } from "@webmcp-guard/shared";

/**
 * One-time human confirmations (`docs/03-architecture.md`: "the server issues a
 * one-time confirmation id so the approval can't be replayed").
 *
 * The flow, and why each piece exists:
 *
 *  1. `/gate` returns `require-confirmation` and mints an id bound to
 *     `sha256(canonical(app, tool, args))`.
 *  2. The SDK shows the person a modal describing *those* arguments.
 *  3. On approval the SDK re-issues the same gate call with the id.
 *  4. `/gate` **consumes the id first**, then validates it. Burning before
 *     judging means a replay, a tampered replay and an expired replay all
 *     destroy the id — an attacker cannot probe for a still-live approval by
 *     retrying with different arguments.
 *
 * What this is *not*: authentication of the human. Anyone who can run script in
 * the page can click the button, and the page is not a boundary against its own
 * user (`docs/03` threat model). It is a control on the **agent channel** — the
 * model cannot approve its own call, because the id only exists after a real
 * DOM interaction the person had to make.
 */

/** How long an unused approval stays valid. Long enough to read, short enough to matter. */
export const CONFIRMATION_TTL_MS = 120_000;

/**
 * Deterministic JSON: object keys sorted, everything else preserved.
 *
 * The hash has to be stable across two independent requests that carry "the
 * same" arguments, and JSON object key order is not guaranteed to survive a
 * round trip through the agent. Sorting keys makes the binding about *values*.
 * Arrays keep their order — `["a","b"]` and `["b","a"]` are different calls.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    // `undefined` members disappear through `JSON.stringify` anyway; dropping
    // them here keeps `{a: undefined}` and `{}` hashing identically, which is
    // what the wire does to them too.
    if (source[key] === undefined) continue;
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * The binding between an approval and the exact call it approved.
 *
 * A hash rather than a copy of the arguments: the confirmation table is not
 * encrypted, and arguments routinely contain patient identifiers. It also
 * cannot be reversed into "what did the human approve" — the audit log's
 * payloads are the record for that, and they are admin-gated.
 */
export function hashCallArgs(app: string, tool: string, args: JsonObject): string {
  return createHash("sha256").update(canonicalJson({ app, tool, args }), "utf8").digest("hex");
}

/** Why a presented confirmation id was refused. Each maps to its own message. */
export type ConfirmationFailure =
  "unknown-or-used" | "expired" | "arguments-changed" | "different-call";

/**
 * Validates an already-consumed confirmation against the call presenting it.
 * Returns `null` when the approval stands.
 *
 * Order matters only for the message the agent reads — every branch here is
 * reached *after* the id has been destroyed.
 */
export function validateConfirmation(
  entry: ConfirmationEntry | null,
  call: { app: string; tool: string; args: JsonObject },
  now: number,
): ConfirmationFailure | null {
  if (entry === null) return "unknown-or-used";
  if (entry.app !== call.app || entry.tool !== call.tool) return "different-call";

  const expiresAt = Date.parse(entry.expiresAt);
  // An unparsable expiry is treated as expired: fail closed.
  if (!Number.isFinite(expiresAt) || now > expiresAt) return "expired";

  if (entry.argsHash !== hashCallArgs(call.app, call.tool, call.args)) return "arguments-changed";
  return null;
}
