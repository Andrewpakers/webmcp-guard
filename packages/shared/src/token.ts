import { DATA_CLASSES, type DataClass } from "./data-class";

/**
 * The WebMCP Guard token *format* — shape only, no secrets and no crypto.
 *
 * `docs/03-architecture.md` → "Tokenization design" fixes the wire shape:
 *
 * ```
 * token = "tok_" + <data class> + "_" + hmac_sha256(value, org_secret)[0:8]
 * ```
 *
 * e.g. `tok_name_1a2b3c4d`, `tok_credit_card_99aa00bb`. Lowercase ASCII with
 * underscores only: chosen because language models copy it verbatim without
 * mangling it, and because it is recognisable to a human reading an audit log.
 *
 * This module lives in `@webmcp-guard/shared` so that everything which merely
 * *recognises* a token — the console's log viewer, the browser SDK, tests — can
 * do so without importing `node:crypto`. Minting and reversing tokens is the
 * server's job alone (`@webmcp-guard/server`: `tokenize.ts`), because only the
 * server holds `GUARD_ORG_SECRET` and `GUARD_VAULT_KEY`.
 */

/** Every token starts with this. */
export const TOKEN_PREFIX = "tok_" as const;

/** Number of lowercase hex characters of HMAC output carried in a token. */
export const TOKEN_DIGEST_LENGTH = 8 as const;

/**
 * Data classes, longest first, so the alternation can never settle for a prefix
 * of a longer class name. (No v1 class is a prefix of another, but the ordering
 * makes that a property of the code rather than a coincidence of the enum.)
 */
const CLASS_ALTERNATION = [...DATA_CLASSES].sort((a, b) => b.length - a.length).join("|");

/**
 * Source of the "find tokens inside a larger string" pattern.
 *
 * `\b` on both ends is load-bearing: `_` is a word character, so
 * `tok_name_1a2b3c4d` inside `xtok_name_1a2b3c4dz` does **not** match, and a
 * token can never be spliced out of the middle of a longer identifier.
 */
export const GUARD_TOKEN_SOURCE = `\\btok_(?:${CLASS_ALTERNATION})_[0-9a-f]{${TOKEN_DIGEST_LENGTH}}\\b`;

const EXACT_TOKEN = new RegExp(`^tok_(${CLASS_ALTERNATION})_([0-9a-f]{${TOKEN_DIGEST_LENGTH}})$`);

/**
 * A fresh global regex that finds every token in a string.
 *
 * Always returns a **new** RegExp: a shared `/g` instance carries `lastIndex`
 * between calls, which silently skips matches when two scans interleave.
 */
export function guardTokenPattern(): RegExp {
  return new RegExp(GUARD_TOKEN_SOURCE, "g");
}

/** True when the whole string is exactly one token. */
export function isGuardToken(value: string): boolean {
  return EXACT_TOKEN.test(value);
}

/** Splits a token into its parts, or `null` when it is not one. */
export function parseGuardToken(
  value: string,
): { token: string; dataClass: DataClass; digest: string } | null {
  const match = EXACT_TOKEN.exec(value);
  if (match === null) return null;
  return { token: value, dataClass: match[1] as DataClass, digest: match[2] };
}

/**
 * Assembles a token from its parts.
 *
 * @throws {TypeError} when the digest is not exactly
 *   {@link TOKEN_DIGEST_LENGTH} lowercase hex characters — a malformed token
 *   would be unrecognisable to every scanner in the product.
 */
export function formatGuardToken(dataClass: DataClass, digest: string): string {
  if (!new RegExp(`^[0-9a-f]{${TOKEN_DIGEST_LENGTH}}$`).test(digest)) {
    throw new TypeError(
      `formatGuardToken: digest must be ${TOKEN_DIGEST_LENGTH} lowercase hex characters, got "${digest}".`,
    );
  }
  return `${TOKEN_PREFIX}${dataClass}_${digest}`;
}
