import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionContext } from "@webmcp-guard/shared";

import { PORTAL_PERSONA_COOKIE, PORTAL_SESSION_COOKIE } from "./cookie-names";
import { DEFAULT_PERSONA, findPersona, sessionContextOf, type Persona } from "./personas";

/**
 * The portal's mock session cookie: signed, verified server-side, and the only
 * thing the guard's `resolveSession` trusts (`docs/07` Phase 6).
 *
 * ⚠️ **Server-only** — it imports `node:crypto`. Client components read the
 * *display* cookie through `lib/session/browser.ts` instead, which is a
 * convenience for the SDK's `getSessionContext` and is not trusted by anything.
 *
 * ## Shape
 *
 * `base64url(userId.role.issuedAt) + "." + base64url(HMAC-SHA256(key, userId.role.issuedAt))`
 *
 * The signed string is the canonical form, not the base64: signing what you
 * transmit rather than what you mean is how encoding-confusion bugs start.
 *
 * ## What it is not
 *
 * There is **no expiry**, and that is a decision rather than an oversight. These
 * are three demo personas on a synthetic dataset (`docs/01`: "mock role-based
 * login only. Real SSO / OIDC is out of scope") — a session lifetime would be
 * theatre, and a judge whose cookie quietly expired mid-recording would just be
 * confused. `issuedAt` is carried and signed so the format does not have to
 * change when someone does bolt on a real identity provider; nothing reads it
 * today. A real deployment needs expiry, rotation and revocation, and would get
 * all three from its IdP rather than from this file.
 */

/** Re-exported so server code has one import for everything session-shaped. */
export { PORTAL_PERSONA_COOKIE, PORTAL_SESSION_COOKIE };

/**
 * Used when neither `PORTAL_SESSION_SECRET` nor `GUARD_ORG_SECRET` is set, so a
 * clean clone boots with a working switcher — the same zero-setup trade-off, and
 * the same obviously-broken naming, as `GUARD_DEV_DEFAULTS` in
 * `lib/guard/server.ts`.
 */
export const PORTAL_SESSION_DEV_DEFAULT = "dev-only-portal-session-secret--do-not-deploy";

/** Domain separation: the session key is never literally the tokenization key. */
const KEY_LABEL = "lakeside-portal/mock-session/v1";

type Env = Record<string, string | undefined>;

export interface PortalSessionSecret {
  /** The derived signing key. */
  secret: string;
  /** Which env var it came from, or the dev default. */
  source: "PORTAL_SESSION_SECRET" | "GUARD_ORG_SECRET" | "development default";
  /** True when nothing was configured and the committed default was used. */
  fellBack: boolean;
}

/**
 * Resolves the signing key: `PORTAL_SESSION_SECRET` if set, otherwise derived
 * from `GUARD_ORG_SECRET`, otherwise derived from the committed dev default.
 *
 * Every branch goes through the same HMAC derivation, so the cookie key is a
 * *different* key from the guard's token secret even when it is the only secret
 * the deployment sets. Reusing one secret for two purposes is the kind of thing
 * that is free to avoid and expensive to discover later.
 */
export function resolvePortalSessionSecret(env: Env = process.env): PortalSessionSecret {
  const configured = env.PORTAL_SESSION_SECRET?.trim();
  if (configured)
    return { secret: deriveKey(configured), source: "PORTAL_SESSION_SECRET", fellBack: false };

  const org = env.GUARD_ORG_SECRET?.trim();
  if (org) return { secret: deriveKey(org), source: "GUARD_ORG_SECRET", fellBack: false };

  return {
    secret: deriveKey(PORTAL_SESSION_DEV_DEFAULT),
    source: "development default",
    fellBack: true,
  };
}

function deriveKey(base: string): string {
  return createHmac("sha256", base).update(KEY_LABEL).digest("hex");
}

/** The one-line warning printed when the committed default is in use. */
export function portalSessionSecretWarning(): string {
  return (
    "[Lakeside portal] Signing mock session cookies with a committed development key. " +
    "Anyone can mint a session for any persona. Set PORTAL_SESSION_SECRET (or GUARD_ORG_SECRET) " +
    "in apps/portal/.env.local before deploying."
  );
}

export interface PortalSessionPayload {
  userId: string;
  role: string;
  /** Epoch milliseconds. Signed, recorded, and deliberately never checked. */
  issuedAt: number;
}

/** `userId.role.issuedAt` — what actually gets signed. */
export function canonicalPayload(payload: PortalSessionPayload): string {
  return `${payload.userId}.${payload.role}.${payload.issuedAt}`;
}

function base64url(input: Buffer | string): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return bytes.toString("base64url");
}

function hmac(secret: string, message: string): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

/** Signs a payload into the `payload.signature` cookie value. */
export function signSessionCookie(payload: PortalSessionPayload, secret: string): string {
  const canonical = canonicalPayload(payload);
  return `${base64url(canonical)}.${base64url(hmac(secret, canonical))}`;
}

/**
 * Verifies a cookie value and returns its payload, or `null` for anything that
 * is not exactly one untampered signature over one well-formed payload.
 *
 * `null` covers every failure — wrong shape, wrong signature, non-numeric
 * `issuedAt`, a payload with an extra dot in it. The caller falls back to the
 * default persona rather than trying to salvage a broken cookie.
 */
export function verifySessionCookie(
  value: string | undefined,
  secret: string,
): PortalSessionPayload | null {
  if (typeof value !== "string") return null;

  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts;
  if (!encodedPayload || !encodedSignature) return null;

  let canonical: string;
  try {
    canonical = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Round trip: base64url has multiple spellings of the same bytes (padding,
  // stray characters), and only the canonical one is accepted.
  if (base64url(canonical) !== encodedPayload) return null;

  const expected = hmac(secret, canonical);
  let presented: Buffer;
  try {
    presented = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak-free
  // answer: a signature of the wrong length is wrong.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  const fields = canonical.split(".");
  if (fields.length !== 3) return null;
  const [userId, role, issuedAtRaw] = fields;
  const issuedAt = Number(issuedAtRaw);
  if (!userId || !role || !Number.isInteger(issuedAt)) return null;

  return { userId, role, issuedAt };
}

/** `a=1; b=2` → `{ a: "1", b: "2" }`. Never throws on malformed input. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string" || header.length === 0) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface PortalSession {
  persona: Persona;
  /** `cookie` when a valid signature named this persona; `default` otherwise. */
  source: "cookie" | "default";
}

/**
 * The active persona for a request.
 *
 * Anything short of a valid signature over a *known* persona whose role still
 * matches falls back to {@link DEFAULT_PERSONA} — absent cookie, tampered
 * cookie, cookie signed with the previous secret, cookie naming a persona that
 * no longer exists. The portal is a demo with no login wall: "not signed in"
 * has to mean "signed in as Dr. Reyes", not "blocked".
 */
export function readPortalSession(request: Request, env: Env = process.env): PortalSession {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return personaFromSignedCookie(cookies[PORTAL_SESSION_COOKIE], env);
}

/**
 * The same resolution from a raw cookie *value*, for callers that hold a cookie
 * store rather than a `Request` — the root layout reads `next/headers`.
 */
export function personaFromSignedCookie(
  value: string | undefined,
  env: Env = process.env,
): PortalSession {
  const payload = verifySessionCookie(value, resolvePortalSessionSecret(env).secret);
  if (payload === null) return { persona: DEFAULT_PERSONA, source: "default" };

  const persona = findPersona(payload.userId);
  // The signed role has to still be the role that persona holds. A cookie
  // minted before the persona list changed is stale, not authoritative — the
  // list in `personas.ts` is the record, the cookie only points at it.
  if (persona === undefined || persona.role !== payload.role) {
    return { persona: DEFAULT_PERSONA, source: "default" };
  }
  return { persona, source: "cookie" };
}

/** What `GuardServerConfig.resolveSession` hands the policy engine. */
export function portalSessionContext(request: Request, env: Env = process.env): SessionContext {
  return sessionContextOf(readPortalSession(request, env).persona);
}

export interface CookieOptions {
  /** Adds `Secure`. The API route derives it from the request's scheme. */
  secure: boolean;
  secret?: string;
  /** Injectable clock so a test can pin `issuedAt`. */
  now?: number;
}

/**
 * The two `Set-Cookie` headers a persona switch writes.
 *
 * No `Max-Age`/`Expires` on either: they are browser-session cookies, matching
 * the no-expiry design described at the top of this file. `SameSite=Lax` is
 * enough here — the switch is a same-origin POST from the portal's own header,
 * and there is nothing to protect anyway (a forged switch changes which fake
 * clinician a demo is pretending to be, and the audit log records which one it
 * was).
 */
export function personaCookieHeaders(persona: Persona, options: CookieOptions): string[] {
  const secret = options.secret ?? resolvePortalSessionSecret().secret;
  const value = signSessionCookie(
    { userId: persona.id, role: persona.role, issuedAt: options.now ?? Date.now() },
    secret,
  );
  const secure = options.secure ? "; Secure" : "";

  return [
    `${PORTAL_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}`,
    // Deliberately *not* httpOnly: this one is for the page to read.
    `${PORTAL_PERSONA_COOKIE}=${persona.id}; Path=/; SameSite=Lax${secure}`,
  ];
}
