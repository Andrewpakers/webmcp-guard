import type { DataClass } from "@webmcp-guard/shared";

/**
 * Masked-at-rest UI fields (`docs/05` § "Stretch (anti-circumvention demo)";
 * `docs/03` threat model, mitigation (1)).
 *
 * The rule this module exists to serve: **the raw value of a masked field never
 * reaches the browser** — not as text, not as an attribute, not inside the RSC
 * payload of a client component's props. The server renders a mask *string*, the
 * page ships that string, and the real value only travels in the response to an
 * explicit `POST /api/portal/reveal-field`, which is written to the guard's
 * audit log before it answers.
 *
 * That is the whole difference between this and a `display:none` mask, which
 * would be theatre: an agent that scrapes the DOM (or reads the flight payload,
 * or opens view-source) finds bullets, and the only way to the value is a call
 * that leaves a record naming who took it.
 *
 * Pure and dependency-free on purpose: it is imported by the server components
 * that build the masks, by the route handler that checks the field name, and by
 * the client component that renders them.
 */

/**
 * The fields the portal masks at rest and can reveal one at a time.
 *
 * Each name is *also* a guard {@link DataClass}, which is what the `satisfies`
 * is holding in place: the audit entry a reveal writes files itself under this
 * exact class, so the console's "show me everything that touched an SSN" filter
 * catches human reveals and agent tool calls in the same query.
 */
export const REVEALABLE_FIELDS = [
  "ssn",
  "dob",
  "phone",
  "email",
] as const satisfies readonly DataClass[];

export type RevealableField = (typeof REVEALABLE_FIELDS)[number];

/** Narrows an untrusted value (a JSON body, a query string) to a known field. */
export function isRevealableField(value: unknown): value is RevealableField {
  return typeof value === "string" && (REVEALABLE_FIELDS as readonly string[]).includes(value);
}

/** How each field is named in UI labels and in the audit entry's message. */
export const REVEAL_FIELD_LABELS: Record<RevealableField, string> = {
  ssn: "SSN",
  dob: "date of birth",
  phone: "phone number",
  email: "e-mail address",
};

const BULLET = "•";

/** Anything with no recognisable shape. Never empty — an empty mask would leak. */
export const GENERIC_MASK = BULLET.repeat(8);

export const SSN_MASK = `${BULLET.repeat(3)}-${BULLET.repeat(2)}-${BULLET.repeat(4)}`;

export const DATE_MASK = `${BULLET.repeat(2)}/${BULLET.repeat(2)}/${BULLET.repeat(4)}`;

/**
 * Constant, not shape-preserving: the local part and the domain of an address
 * are both varying-length, and bullets that tracked their lengths would be a
 * (small, free) hint no one needs.
 */
export const EMAIL_MASK = `${BULLET.repeat(6)}@${BULLET.repeat(6)}`;

/** Longest shape-preserving mask; longer values collapse to {@link GENERIC_MASK}. */
const MAX_MASK_LENGTH = 24;

const SSN_SHAPE = /^\d{3}-\d{2}-\d{4}$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const SLASH_DATE_SHAPE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * The mask a field renders while it is at rest.
 *
 * Computed **on the server** from the real value, so the shape can follow the
 * value's own punctuation — `(555) 555-0100` masks as `(•••) •••-••••`, which
 * looks like the phone number a clinician expects to see rather than a row of
 * anonymous dots. What crosses to the browser is only this string.
 *
 * What a mask discloses, stated plainly, because "it's masked" is not an
 * argument: the *kind* of value (which the field label already said out loud)
 * and, for the shape-preserving branch, how many characters it has and where
 * its separators are. Never a character of the value itself.
 */
export function maskAtRest(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return GENERIC_MASK;

  if (SSN_SHAPE.test(trimmed)) return SSN_MASK;
  if (ISO_DATE_SHAPE.test(trimmed) || SLASH_DATE_SHAPE.test(trimmed)) return DATE_MASK;
  if (trimmed.includes("@")) return EMAIL_MASK;
  if (trimmed.length > MAX_MASK_LENGTH) return GENERIC_MASK;

  const shaped = [...trimmed]
    .map((character) => (ALPHANUMERIC.test(character) ? BULLET : character))
    .join("");
  // A value made entirely of punctuation would mask as itself, which is not a
  // mask at all.
  return shaped.includes(BULLET) ? shaped : GENERIC_MASK;
}
