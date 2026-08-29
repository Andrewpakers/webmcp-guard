import { VaultEntrySchema, isGuardToken, parseGuardToken } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { canonicalizeDate, canonicalizeValue, createTokenizer } from "./tokenize";

/**
 * Determinism, canonicalization and the vault crypto — the three things the
 * rest of Phase 3 stands on. If any of these slips, tokens stop matching across
 * turns and detokenization silently hands back the wrong person's data.
 */

const ORG_SECRET = "org-secret-for-tests";
const VAULT_KEY = "vault-key-for-tests";

function tokenizer(overrides: { orgSecret?: string; vaultKey?: string } = {}) {
  return createTokenizer({
    orgSecret: overrides.orgSecret ?? ORG_SECRET,
    vaultKey: overrides.vaultKey ?? VAULT_KEY,
  });
}

describe("token format", () => {
  it("mints tok_<class>_<hex8>", () => {
    const token = tokenizer().tokenFor("927-78-1337", "ssn");

    expect(token).toMatch(/^tok_ssn_[0-9a-f]{8}$/);
    expect(isGuardToken(token)).toBe(true);
    expect(parseGuardToken(token)).toMatchObject({ dataClass: "ssn" });
  });

  it("keeps the class in the token even for multi-word classes", () => {
    expect(tokenizer().tokenFor("4111111111111111", "credit_card")).toMatch(
      /^tok_credit_card_[0-9a-f]{8}$/,
    );
    expect(tokenizer().tokenFor("a note", "free_text_phi")).toMatch(
      /^tok_free_text_phi_[0-9a-f]{8}$/,
    );
  });
});

describe("determinism", () => {
  it("gives the same value the same token, every time and in every instance", () => {
    const a = tokenizer();
    const b = tokenizer();

    expect(a.tokenFor("Tricia Bashirian", "name")).toBe(a.tokenFor("Tricia Bashirian", "name"));
    expect(a.tokenFor("Tricia Bashirian", "name")).toBe(b.tokenFor("Tricia Bashirian", "name"));
  });

  it("gives different values different tokens", () => {
    const guard = tokenizer();
    expect(guard.tokenFor("927-78-1337", "ssn")).not.toBe(guard.tokenFor("927-78-1338", "ssn"));
  });

  it("binds the class into the digest, so the same digits do not collide across classes", () => {
    const guard = tokenizer();
    const asSsn = tokenizer().tokenFor("123456789", "ssn");
    const asMrn = guard.tokenFor("123456789", "mrn");

    expect(asSsn.slice("tok_ssn_".length)).not.toBe(asMrn.slice("tok_mrn_".length));
  });

  it("depends on the org secret", () => {
    const mine = tokenizer().tokenFor("927-78-1337", "ssn");
    const theirs = tokenizer({ orgSecret: "a-different-org" }).tokenFor("927-78-1337", "ssn");

    expect(mine).not.toBe(theirs);
  });
});

describe("canonicalization", () => {
  const guard = tokenizer();
  const same = (dataClass: Parameters<typeof guard.tokenFor>[1], a: string, b: string) =>
    expect(guard.tokenFor(a, dataClass)).toBe(guard.tokenFor(b, dataClass));

  it("collapses SSN spellings onto one token", () => {
    same("ssn", "927-78-1337", "927781337");
    same("ssn", "927-78-1337", "927 78 1337");
  });

  it("collapses phone and card spellings", () => {
    same("phone", "(206) 555-0142", "206.555.0142");
    same("phone", "(206) 555-0142", "2065550142");
    same("credit_card", "4111 1111 1111 1111", "4111-1111-1111-1111");
  });

  it("collapses record-number case and punctuation", () => {
    same("mrn", "LM-100042", "lm100042");
    same("insurance_id", "abc-123-456", "ABC123456");
  });

  it("folds case and whitespace for names, e-mail and addresses", () => {
    same("name", "Tricia Bashirian", "  tricia   bashirian ");
    same("email", "Tricia.B@Example.COM", "tricia.b@example.com");
    same("address", "123 Elm St", "123  ELM  ST");
  });

  it("normalises dates to ISO before hashing", () => {
    same("dob", "1985-04-12", "4/12/1985");
    same("dob", "1985-04-12", "1985-4-12");
    expect(canonicalizeDate("4/12/1985")).toBe("1985-04-12");
    expect(canonicalizeDate("not a date")).toBe("not a date");
  });

  it("keeps free text case-sensitive but whitespace-insensitive", () => {
    same("free_text_phi", "Called about\n refill.", "Called about refill.");
    expect(guard.tokenFor("called about refill.", "free_text_phi")).not.toBe(
      guard.tokenFor("Called about refill.", "free_text_phi"),
    );
  });

  it("exposes the canonical form for each class", () => {
    expect(canonicalizeValue("(206) 555-0142", "phone")).toBe("2065550142");
    expect(canonicalizeValue("lm-100042", "mrn")).toBe("LM100042");
    expect(canonicalizeValue("  Ada   BYRON ", "name")).toBe("ada byron");
  });
});

describe("vault crypto", () => {
  it("round-trips a value through AES-256-GCM", () => {
    const guard = tokenizer();
    const { token, entry } = guard.seal("927-78-1337", "ssn");

    expect(entry.token).toBe(token);
    expect(entry.dataClass).toBe("ssn");
    expect(VaultEntrySchema.safeParse(entry).success).toBe(true);
    expect(guard.open(entry)).toBe("927-78-1337");
  });

  it("stores the original spelling, not the canonical one", () => {
    const guard = tokenizer();
    const first = guard.seal("927-78-1337", "ssn");
    const second = guard.seal("927781337", "ssn");

    // Same token (canonicalization), different plaintext behind each row — the
    // storage adapter is first-write-wins, so the first spelling is what a
    // deployment keeps.
    expect(second.token).toBe(first.token);
    expect(guard.open(first.entry)).toBe("927-78-1337");
    expect(guard.open(second.entry)).toBe("927781337");
  });

  it("never repeats an IV", () => {
    const guard = tokenizer();
    const ivs = new Set(
      Array.from({ length: 50 }, () => guard.seal("927-78-1337", "ssn").entry.iv),
    );
    expect(ivs.size).toBe(50);
  });

  it("does not leak the plaintext into the stored row", () => {
    const { entry } = tokenizer().seal("927-78-1337", "ssn");
    expect(JSON.stringify(entry)).not.toContain("927");
    expect(JSON.stringify(entry)).not.toContain("1337");
  });

  it("cannot be opened with a different vault key", () => {
    const { entry } = tokenizer().seal("927-78-1337", "ssn");
    expect(tokenizer({ vaultKey: "someone-elses-key" }).open(entry)).toBeNull();
  });

  it("refuses a tampered auth tag", () => {
    const guard = tokenizer();
    const { entry } = guard.seal("927-78-1337", "ssn");
    const tag = Buffer.from(entry.authTag, "base64");
    tag[0] ^= 0xff;

    expect(guard.open({ ...entry, authTag: tag.toString("base64") })).toBeNull();
  });

  it("refuses a tampered ciphertext", () => {
    const guard = tokenizer();
    const { entry } = guard.seal("927-78-1337", "ssn");
    const ciphertext = Buffer.from(entry.ciphertext, "base64");
    ciphertext[0] ^= 0xff;

    expect(guard.open({ ...entry, ciphertext: ciphertext.toString("base64") })).toBeNull();
  });

  it("refuses a row whose ciphertext was moved onto another token (AAD binding)", () => {
    const guard = tokenizer();
    const secret = guard.seal("927-78-1337", "ssn");
    const decoy = guard.seal("111-11-1111", "ssn");

    const swapped = {
      ...decoy.entry,
      ciphertext: secret.entry.ciphertext,
      iv: secret.entry.iv,
      authTag: secret.entry.authTag,
    };
    expect(guard.open(swapped)).toBeNull();
  });

  it("refuses malformed rows rather than throwing", () => {
    const guard = tokenizer();
    const { entry } = guard.seal("927-78-1337", "ssn");

    expect(guard.open({ ...entry, iv: "!!!not base64!!!" })).toBeNull();
    expect(guard.open({ ...entry, ciphertext: "" })).toBeNull();
  });

  it("stamps firstSeenAt from the injected clock", () => {
    const guard = createTokenizer({
      orgSecret: ORG_SECRET,
      vaultKey: VAULT_KEY,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    expect(guard.seal("x", "name").entry.firstSeenAt).toBe("2026-08-29T12:00:00.000Z");
  });
});
