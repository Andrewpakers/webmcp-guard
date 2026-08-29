import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Admin authentication for the console-facing routes (`/policies`, `/logs`,
 * `/stats`): a single bearer token from the environment, exactly as
 * `docs/03-architecture.md` specifies. There is no user management and no RBAC
 * for admins — `docs/06-console-requirements.md` lists both as non-goals.
 *
 * `/gate` and `/transform` are deliberately *not* covered by this: see the note
 * on those routes in `server.ts`.
 */

/**
 * Compares two secrets without leaking how much of the guess was right.
 *
 * Both sides are SHA-256'd first, which does two useful things: it makes the
 * buffers equal-length (so `timingSafeEqual` cannot throw on a length mismatch,
 * which would itself be a length oracle), and it means the comparison time is
 * independent of the input length.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Pulls the token out of `Authorization: Bearer <token>`; `null` when absent. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;

  const match = /^bearer[ \t]+(\S.*)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** True when the request carries the configured admin token. */
export function isAdminRequest(request: Request, adminToken: string): boolean {
  const provided = bearerToken(request);
  if (provided === null) return false;
  return secretsMatch(provided, adminToken);
}

/**
 * The single 401 message. It is identical for a missing token, a malformed
 * header and a wrong token, so a caller learns nothing about how close it got.
 */
export const UNAUTHORIZED_MESSAGE =
  "Admin authorization required. Send `Authorization: Bearer <GUARD_ADMIN_TOKEN>`.";
