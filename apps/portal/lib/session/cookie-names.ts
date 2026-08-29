/**
 * The two cookie names, in a module with **no Node imports**, so client code can
 * name them without dragging `node:crypto` (and therefore all of `cookie.ts`)
 * into the browser bundle.
 */

/** Signed identity. `httpOnly` — the page cannot read or forge it. */
export const PORTAL_SESSION_COOKIE = "lakeside_session";

/**
 * Unsigned, page-readable copy of the active persona id, so the SDK's
 * `getSessionContext` has something to report. Not trusted by anything: the
 * gate resolves identity from the signed cookie above.
 */
export const PORTAL_PERSONA_COOKIE = "lakeside_persona";
