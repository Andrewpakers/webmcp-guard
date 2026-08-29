import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import {
  TOKEN_DIGEST_LENGTH,
  VaultEntrySchema,
  formatGuardToken,
  type DataClass,
  type VaultEntry,
} from "@webmcp-guard/shared";

/**
 * Deterministic tokenization and the encrypted token vault
 * (`docs/03-architecture.md` → "Tokenization design").
 *
 * Two independent secrets, two independent jobs:
 *
 * - **`orgSecret`** keys an HMAC-SHA256 over the *canonicalized* value. The
 *   first 8 hex characters become the token's digest, so the same person's SSN
 *   yields the same token in every tool, every turn, forever — which is exactly
 *   what lets an agent reason across calls without ever seeing PHI. HMAC (not a
 *   bare hash) means an attacker who guesses a value cannot confirm the guess
 *   without also holding `GUARD_ORG_SECRET`.
 * - **`vaultKey`** keys AES-256-GCM over the original value. Only the server
 *   can reverse a token, and only through `getVaultEntry` + `decrypt`.
 *
 * ### Truncation, honestly
 *
 * 8 hex characters is 32 bits. Collisions are therefore possible in principle
 * (birthday bound ≈ 2^16 ≈ 65k distinct values per class before a 50% chance of
 * one collision). The vault is first-write-wins, so a collision would make two
 * different values share one token and detokenize to whichever was seen first.
 * The format is fixed by `docs/03` because agent-legibility is the point; the
 * mitigation is that the token space is *per data class* and a deployment with
 * millions of distinct values per class should widen
 * `TOKEN_DIGEST_LENGTH`. Written down here rather than discovered later.
 *
 * ### What this module deliberately does not do
 *
 * It never touches storage. `putVaultEntry` is the caller's call to make, so
 * the transform pipeline stays synchronous and testable and the storage
 * adapter stays the only async surface.
 */

/** AES-256-GCM standard nonce length. Never reused: one random IV per entry. */
const IV_BYTES = 12;

/**
 * Canonical forms per class, applied *before* the HMAC so that two spellings of
 * one value collapse onto one token (`docs/04`: the agent must be able to match
 * identities across tools).
 *
 * The vault still stores the **original, first-seen** spelling, so
 * detokenization hands the site back something a human wrote, not a normalised
 * shadow of it.
 */
export function canonicalizeValue(value: string, dataClass: DataClass): string {
  switch (dataClass) {
    case "ssn":
    case "phone":
    case "credit_card":
      // "927-78-1337", "927 78 1337" and "927781337" are one identity.
      return value.replace(/\D+/g, "");
    case "mrn":
    case "insurance_id":
      // Record numbers are case- and punctuation-insensitive in practice:
      // "lm-100042" and "LM100042" are the same chart.
      return value.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
    case "name":
    case "address":
      return value.trim().replace(/\s+/g, " ").toLowerCase();
    case "email":
      return value.trim().toLowerCase();
    case "dob":
      return canonicalizeDate(value);
    case "free_text_phi":
      // Free text is canonicalized on whitespace only. Case and punctuation are
      // meaning-bearing in a clinical note, so folding them would merge notes
      // that are genuinely different documents.
      return value.trim().replace(/\s+/g, " ");
    default: {
      const exhaustive: never = dataClass;
      return String(exhaustive);
    }
  }
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** `3/4/1985`, `1985-3-4` and `1985-03-04` all canonicalize to `1985-03-04`. */
export function canonicalizeDate(value: string): string {
  const trimmed = value.trim();

  const iso = ISO_DATE.exec(trimmed);
  if (iso !== null) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;

  const us = US_DATE.exec(trimmed);
  if (us !== null) return `${us[3]}-${pad2(us[1])}-${pad2(us[2])}`;

  // Anything else (a timestamp, prose, a partial date) keeps its own shape,
  // whitespace-normalised. Two spellings that do not parse simply do not merge.
  return trimmed.replace(/\s+/g, " ");
}

function pad2(value: string): string {
  return value.padStart(2, "0");
}

export interface TokenizerOptions {
  /** `GUARD_ORG_SECRET` — HMAC key behind the deterministic token digest. */
  orgSecret: string;
  /** `GUARD_VAULT_KEY` — stretched to 32 bytes for AES-256-GCM. */
  vaultKey: string;
  /** Injectable clock so `firstSeenAt` is assertable in tests. */
  now?: () => Date;
}

export interface Tokenizer {
  /** The deterministic `tok_<class>_<hex8>` for a value. Pure; no I/O. */
  tokenFor(value: string, dataClass: DataClass): string;
  /**
   * Mints the token *and* the encrypted vault row for a value. The row is
   * returned rather than stored: the caller decides when (and whether) to
   * persist it, and `putVaultEntry` is first-write-wins so re-encrypting an
   * already-known value is harmless.
   */
  seal(value: string, dataClass: DataClass): { token: string; entry: VaultEntry };
  /** Reverses a vault row. `null` for the wrong key, a tampered row, or garbage. */
  open(entry: VaultEntry): string | null;
}

/**
 * Derives the AES key from the configured passphrase.
 *
 * SHA-256 of the env string is a *format* conversion, not a password KDF: it
 * makes any-length configuration usable as a 32-byte key. `GUARD_VAULT_KEY` is
 * expected to be a high-entropy secret — `.env.example` asks for "32 bytes,
 * base64 or hex", i.e. `openssl rand -hex 32` — not a human-chosen passphrase.
 * If it ever had to accept passphrases this would need scrypt or argon2
 * instead, and the README should say so before that day arrives.
 */
function deriveVaultKey(vaultKey: string): Buffer {
  return createHash("sha256").update(vaultKey, "utf8").digest();
}

export function createTokenizer(options: TokenizerOptions): Tokenizer {
  const orgSecret = options.orgSecret;
  const key = deriveVaultKey(options.vaultKey);
  const now = options.now ?? (() => new Date());

  function tokenFor(value: string, dataClass: DataClass): string {
    const canonical = canonicalizeValue(value, dataClass);
    const digest = createHmac("sha256", orgSecret)
      // The class is bound into the HMAC input so the same digits classified as
      // two different things cannot collide onto one vault row.
      .update(`${dataClass}:${canonical}`, "utf8")
      .digest("hex")
      .slice(0, TOKEN_DIGEST_LENGTH);
    return formatGuardToken(dataClass, digest);
  }

  return {
    tokenFor,

    seal(value, dataClass) {
      const token = tokenFor(value, dataClass);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      // The token is authenticated additional data: a row whose ciphertext is
      // swapped onto another token fails to decrypt instead of silently
      // revealing the wrong person's value.
      cipher.setAAD(Buffer.from(token, "utf8"));

      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

      return {
        token,
        entry: VaultEntrySchema.parse({
          token,
          dataClass,
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64"),
          authTag: cipher.getAuthTag().toString("base64"),
          firstSeenAt: now().toISOString(),
        } satisfies VaultEntry),
      };
    },

    open(entry) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
        decipher.setAAD(Buffer.from(entry.token, "utf8"));
        decipher.setAuthTag(Buffer.from(entry.authTag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(entry.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // A wrong key, a tampered ciphertext, a tampered tag, a swapped token,
        // or a malformed row all land here and are indistinguishable to the
        // caller on purpose. The caller treats `null` as "not revealable".
        return null;
      }
    },
  };
}
