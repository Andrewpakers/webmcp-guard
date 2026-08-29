import { describe, expect, it } from "vitest";

import { DATA_CLASSES } from "./data-class";
import {
  TOKEN_DIGEST_LENGTH,
  formatGuardToken,
  guardTokenPattern,
  isGuardToken,
  parseGuardToken,
} from "./token";

/**
 * The token *format* contract. Every consumer — the server's detokenizer, the
 * console's log viewer, an agent copying a token between turns — depends on
 * exactly these rules.
 */

describe("formatGuardToken", () => {
  it("builds tok_<class>_<hex8> for every data class", () => {
    for (const dataClass of DATA_CLASSES) {
      const token = formatGuardToken(dataClass, "1a2b3c4d");
      expect(token).toBe(`tok_${dataClass}_1a2b3c4d`);
      expect(parseGuardToken(token)).toEqual({ token, dataClass, digest: "1a2b3c4d" });
    }
  });

  it("refuses a digest that is not the agreed length or alphabet", () => {
    expect(() => formatGuardToken("ssn", "1a2b3c4")).toThrow(TypeError);
    expect(() => formatGuardToken("ssn", "1A2B3C4D")).toThrow(TypeError);
    expect(() => formatGuardToken("ssn", "zzzzzzzz")).toThrow(TypeError);
    expect(TOKEN_DIGEST_LENGTH).toBe(8);
  });
});

describe("isGuardToken", () => {
  it.each(["tok_ssn_1a2b3c4d", "tok_free_text_phi_00000000", "tok_credit_card_ffffffff"])(
    "accepts %s",
    (token) => {
      expect(isGuardToken(token)).toBe(true);
    },
  );

  it.each([
    "tok_ssn_1a2b3c4",
    "tok_ssn_1a2b3c4dd",
    "tok_ssn_1A2B3C4D",
    "tok_unknown_1a2b3c4d",
    "TOK_SSN_1a2b3c4d",
    " tok_ssn_1a2b3c4d",
    "tok_ssn_1a2b3c4d ",
  ])("rejects %s", (token) => {
    expect(isGuardToken(token)).toBe(false);
    expect(parseGuardToken(token)).toBeNull();
  });
});

describe("guardTokenPattern", () => {
  it("finds tokens inside prose", () => {
    const text = "Call tok_name_1a2b3c4d about tok_mrn_99aa00bb today.";
    expect(text.match(guardTokenPattern())).toEqual(["tok_name_1a2b3c4d", "tok_mrn_99aa00bb"]);
  });

  it("will not splice a token out of a longer identifier", () => {
    expect("xtok_ssn_1a2b3c4d".match(guardTokenPattern())).toBeNull();
    expect("tok_ssn_1a2b3c4dz".match(guardTokenPattern())).toBeNull();
    expect("tok_ssn_1a2b3c4d_extra".match(guardTokenPattern())).toBeNull();
  });

  it("returns a fresh regex each time, so interleaved scans cannot skip matches", () => {
    const first = guardTokenPattern();
    const second = guardTokenPattern();
    expect(first).not.toBe(second);

    first.exec("tok_ssn_1a2b3c4d");
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(second.lastIndex).toBe(0);
  });
});
