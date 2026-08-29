import type { SessionContext } from "@webmcp-guard/shared";

import { PORTAL_PERSONA_COOKIE } from "./cookie-names";
import { DEFAULT_PERSONA, findPersona, sessionContextOf, type Persona } from "./personas";

/**
 * The page's view of who is signed in — what the SDK's `getSessionContext`
 * reports (`docs/04-sdk-requirements.md`).
 *
 * **This is a claim, not a credential.** Everything here is readable and
 * writable from devtools, and the guard knows it: `/gate` re-derives the session
 * from the signed httpOnly cookie server-side (`GuardServerConfig.resolveSession`
 * → `lib/guard/server.ts`) and uses *that* for policy and for the audit entry.
 * Wiring `getSessionContext` anyway is worth it for two honest reasons: it is
 * the documented SDK surface a host app is meant to implement, and the
 * disagreement between claim and reality is recorded on the audit entry, which
 * is a nicer property than never having asked.
 *
 * Two sources, in order:
 *
 *  1. the `lakeside_persona` display cookie, written by `POST /api/session` —
 *     current the instant a switch happens, before any re-render;
 *  2. the `data-session-*` attributes the root layout stamps on `<body>` —
 *     the bootstrap for a first page load that has no cookie yet.
 */

/** Attribute names the root layout writes and this module reads. */
export const SESSION_BOOTSTRAP_ATTRIBUTES = {
  userId: "data-session-user",
  role: "data-session-role",
} as const;

function cookieValue(name: string, cookieString: string): string | undefined {
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** The persona this document believes it is running as. */
export function readBrowserPersona(doc: Document | undefined = globalThis.document): Persona {
  if (doc === undefined) return DEFAULT_PERSONA;

  const fromCookie = findPersona(cookieValue(PORTAL_PERSONA_COOKIE, doc.cookie ?? ""));
  if (fromCookie !== undefined) return fromCookie;

  const bootstrap = doc.body?.getAttribute(SESSION_BOOTSTRAP_ATTRIBUTES.userId);
  return findPersona(bootstrap) ?? DEFAULT_PERSONA;
}

/** `getSessionContext` for `createGuard`. Always answers; never throws. */
export function readBrowserSessionContext(
  doc: Document | undefined = globalThis.document,
): SessionContext {
  return sessionContextOf(readBrowserPersona(doc));
}
