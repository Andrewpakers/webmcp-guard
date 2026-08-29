import { describe, expect, it } from "vitest";

import {
  DATE_MASK,
  EMAIL_MASK,
  GENERIC_MASK,
  REVEALABLE_FIELDS,
  REVEAL_FIELD_LABELS,
  SSN_MASK,
  isRevealableField,
  maskAtRest,
} from "./mask";

/**
 * The mask helper is the one piece of the masked-at-rest feature that is pure,
 * so it is the piece that gets tested directly. The property that matters is
 * the same in every case: **no character of the input survives into the
 * output**, whatever shape the input had.
 */

const BULLET = "•";

describe("maskAtRest", () => {
  it("masks an SSN to the familiar shape", () => {
    expect(maskAtRest("900-01-0001")).toBe(SSN_MASK);
    expect(maskAtRest("  900-01-0001  ")).toBe(SSN_MASK);
  });

  it("masks dates in both spellings the portal stores", () => {
    expect(maskAtRest("1957-03-04")).toBe(DATE_MASK);
    expect(maskAtRest("3/4/1957")).toBe(DATE_MASK);
    expect(maskAtRest("1957-03-04T00:00:00Z")).toBe(DATE_MASK);
  });

  it("masks an e-mail address to a constant, so no length leaks", () => {
    expect(maskAtRest("tricia.bashirian7@example.com")).toBe(EMAIL_MASK);
    expect(maskAtRest("a@b.co")).toBe(EMAIL_MASK);
    expect(maskAtRest("a@b.co")).toBe(maskAtRest("tricia.bashirian7@example.com"));
  });

  it("keeps a phone number's punctuation and bullets every digit", () => {
    expect(maskAtRest("(555) 555-0100")).toBe("(•••) •••-••••");
    expect(maskAtRest("555-0100")).toBe("•••-••••");
    expect(maskAtRest("+1 555 555 0100")).toBe("+• ••• ••• ••••");
  });

  it("falls back to generic bullets for empty, long or unshaped values", () => {
    expect(maskAtRest("")).toBe(GENERIC_MASK);
    expect(maskAtRest("   ")).toBe(GENERIC_MASK);
    expect(maskAtRest("---")).toBe(GENERIC_MASK);
    expect(maskAtRest("x".repeat(200))).toBe(GENERIC_MASK);
  });

  it("never lets a character of the value through", () => {
    const values = [
      "900-01-0001",
      "1957-03-04",
      "(555) 555-0100",
      "tricia.bashirian7@example.com",
      "Ada Byron",
      "",
      "x".repeat(200),
    ];

    for (const value of values) {
      const masked = maskAtRest(value);
      expect(masked.length).toBeGreaterThan(0);
      expect(masked).toContain(BULLET);
      for (const character of new Set(value.replace(/[\s]/g, ""))) {
        if (/[\p{L}\p{N}]/u.test(character)) expect(masked).not.toContain(character);
      }
    }
  });
});

describe("isRevealableField", () => {
  it("accepts exactly the four masked fields", () => {
    for (const field of REVEALABLE_FIELDS) expect(isRevealableField(field)).toBe(true);
  });

  it("rejects anything else, including near misses and non-strings", () => {
    for (const value of ["mrn", "name", "SSN", "ssn ", "", null, undefined, 7, ["ssn"]]) {
      expect(isRevealableField(value)).toBe(false);
    }
  });
});

describe("REVEAL_FIELD_LABELS", () => {
  it("names every revealable field", () => {
    for (const field of REVEALABLE_FIELDS) {
      expect(REVEAL_FIELD_LABELS[field].length).toBeGreaterThan(0);
    }
  });
});
