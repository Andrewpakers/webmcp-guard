import type { DataClass } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  buildNameMatcher,
  classesIn,
  classify,
  classifyKey,
  keyWords,
  passesLuhn,
  scanText,
  singularize,
  type Span,
} from "./classify";

/**
 * Detector coverage per `docs/10-agent-operations.md` §"Must-cover map":
 * every class, plus the negatives that keep the classifier honest — a
 * Luhn-failing digit run is not a card, an appointment date is not a DOB, and
 * `username` is not a person.
 */

const NAMES = ["Tricia Bashirian", "Ada Whitfield", "Grace Hopper-Byron"];
const matcher = buildNameMatcher(NAMES);

function classesOf(text: string): DataClass[] {
  const seen = new Set(scanText(text, { nameMatcher: matcher }).map((span) => span.dataClass));
  return [...seen];
}

function textsOf(text: string, dataClass: DataClass): string[] {
  return scanText(text, { nameMatcher: matcher })
    .filter((span) => span.dataClass === dataClass)
    .map((span) => span.text);
}

describe("keyWords", () => {
  it("splits camelCase, snake_case, kebab-case and SCREAMING keys alike", () => {
    expect(keyWords("firstName")).toEqual(["first", "name"]);
    expect(keyWords("first_name")).toEqual(["first", "name"]);
    expect(keyWords("FIRST-NAME")).toEqual(["first", "name"]);
    expect(keyWords("addressZIP")).toEqual(["address", "zip"]);
    expect(keyWords("insuranceMemberId")).toEqual(["insurance", "member", "id"]);
    expect(keyWords("MRN")).toEqual(["mrn"]);
  });

  it("de-pluralises regularly, without mangling words that end in s", () => {
    expect(singularize("emails")).toBe("email");
    expect(singularize("addresses")).toBe("address");
    expect(singularize("names")).toBe("name");
    expect(singularize("address")).toBe("address");
    expect(singularize("notes")).toBe("note");
  });
});

describe("field-name pass", () => {
  it.each<[string, DataClass]>([
    ["ssn", "ssn"],
    ["SSN", "ssn"],
    ["social_security_number", "ssn"],
    ["mrn", "mrn"],
    ["patientMrn", "mrn"],
    ["recordNumber", "mrn"],
    ["record_number", "mrn"],
    ["medicalRecord", "mrn"],
    ["dob", "dob"],
    ["dateOfBirth", "dob"],
    ["birthDate", "dob"],
    ["firstName", "name"],
    ["last_name", "name"],
    ["fullName", "name"],
    ["name", "name"],
    ["patientName", "name"],
    ["phone", "phone"],
    ["mobile", "phone"],
    ["telephone", "phone"],
    ["email", "email"],
    ["emailAddress", "email"],
    ["address", "address"],
    ["addressStreet", "address"],
    ["addressCity", "address"],
    ["addressState", "address"],
    ["addressZip", "address"],
    ["insuranceCarrier", "insurance_id"],
    ["insuranceMemberId", "insurance_id"],
    ["creditCard", "credit_card"],
    ["cardNumber", "credit_card"],
  ])("classifies %s as %s", (key, expected) => {
    expect(classifyKey(key)).toBe(expected);
  });

  it.each(["username", "user_name", "userName", "fileName", "hostname", "id", "status", "summary"])(
    "leaves %s unclassified",
    (key) => {
      expect(classifyKey(key)).toBeNull();
    },
  );

  it("does not mistake a cardiologist for a credit card", () => {
    expect(classifyKey("cardiologist")).toBeNull();
    expect(classifyKey("cardiology")).toBeNull();
  });

  it("prefers the more specific class when a key names two things", () => {
    // e-mail before address, insurance before the bare id.
    expect(classifyKey("emailAddress")).toBe("email");
    expect(classifyKey("insuranceId")).toBe("insurance_id");
  });
});

describe("regex pass — SSN", () => {
  it("finds the delimited form", () => {
    expect(textsOf("SSN on file is 900-12-3456.", "ssn")).toEqual(["900-12-3456"]);
  });

  it("finds nine bare digits only when the context says SSN", () => {
    expect(textsOf("Social security 900123456 verified.", "ssn")).toEqual(["900123456"]);
    expect(textsOf("SSN: 900123456", "ssn")).toEqual(["900123456"]);
    expect(textsOf("Claim reference 900123456 filed.", "ssn")).toEqual([]);
  });

  it("does not read a phone number as an SSN", () => {
    expect(classesOf("Call (206) 555-0142.")).not.toContain("ssn");
  });
});

describe("regex pass — phone", () => {
  it.each(["(206) 555-0142", "206-555-0142", "206.555.0142", "+1 206-555-0142", "(312) 555-0187"])(
    "finds %s",
    (phone) => {
      expect(textsOf(`Reached them at ${phone} yesterday.`, "phone")).toContain(phone);
    },
  );

  it("does not treat a bare run of ten digits as a phone number", () => {
    expect(classesOf("Claim number 2065550142 was submitted.")).not.toContain("phone");
  });
});

describe("regex pass — e-mail", () => {
  it("finds an address in prose", () => {
    expect(textsOf("Write to tricia.bashirian1@example.com about it.", "email")).toEqual([
      "tricia.bashirian1@example.com",
    ]);
  });

  it("ignores a bare domain", () => {
    expect(classesOf("See example.com for details.")).not.toContain("email");
  });
});

describe("regex pass — MRN", () => {
  it("finds the default LM-###### shape", () => {
    expect(textsOf("Chart LM-100042 was updated.", "mrn")).toEqual(["LM-100042"]);
  });

  it("honours a deployment's own pattern", () => {
    const spans = scanText("Chart 55/12345 was updated.", { mrnPattern: /\b\d{2}\/\d{5}\b/g });
    expect(spans.map((span) => [span.dataClass, span.text])).toEqual([["mrn", "55/12345"]]);
  });
});

describe("regex pass — credit card (Luhn)", () => {
  it("accepts a number that passes the check digit", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(textsOf("Card 4111 1111 1111 1111 on file.", "credit_card")).toEqual([
      "4111 1111 1111 1111",
    ]);
    expect(textsOf("Card 4111-1111-1111-1111 on file.", "credit_card")).toEqual([
      "4111-1111-1111-1111",
    ]);
  });

  it.each(["1234-5678-9012-3456", "1111 1111 1111 1111", "4111111111111112"])(
    "refuses %s, which fails Luhn",
    (candidate) => {
      expect(passesLuhn(candidate.replace(/\D+/g, ""))).toBe(false);
      expect(classesOf(`Card ${candidate} declined.`)).not.toContain("credit_card");
    },
  );

  it("ignores digit runs that are too short or too long to be a card", () => {
    expect(passesLuhn("00000000000000000000")).toBe(true); // 20 digits, valid Luhn
    expect(classesOf("Batch 00000000000000000000 processed.")).not.toContain("credit_card");
    expect(classesOf("Order 000000000000 shipped.")).not.toContain("credit_card"); // 12 digits
  });
});

describe("regex pass — dates in DOB context", () => {
  it.each([
    "DOB 1985-04-12",
    "(DOB 1985-04-12, MRN LM-100001)",
    "born 1985-04-12",
    "date of birth 4/12/1985",
    "1985-04-12 (date of birth on file)",
  ])("classifies %s as a date of birth", (text) => {
    expect(classesOf(text)).toContain("dob");
  });

  it.each([
    "Next appointment 2026-09-14 at 3pm.",
    "Record created 2026-01-01.",
    "Lab drawn on 3/14/2026 and resulted the same day.",
  ])("does not classify %s as a date of birth", (text) => {
    expect(classesOf(text)).not.toContain("dob");
  });

  it("does not fire on an ISO timestamp", () => {
    expect(classesOf("Scheduled for 2026-09-03T15:00:00.000Z.")).not.toContain("dob");
  });
});

describe("dictionary pass — names", () => {
  it("finds a known full name, case-insensitively", () => {
    expect(textsOf("Spoke with Tricia Bashirian today.", "name")).toEqual(["Tricia Bashirian"]);
    expect(textsOf("spoke with tricia bashirian today.", "name")).toEqual(["tricia bashirian"]);
  });

  it("finds honorific plus a known surname", () => {
    expect(textsOf("Ms. Bashirian asked about refills.", "name")).toEqual(["Ms. Bashirian"]);
    expect(textsOf("Dr Whitfield reviewed the chart.", "name")).toEqual(["Dr Whitfield"]);
  });

  it("does not fire on a bare surname without an honorific", () => {
    expect(classesOf("The bashirian technique was used.")).not.toContain("name");
  });

  it("does not fire on a name that is not in the dictionary", () => {
    expect(classesOf("Spoke with Marvin Gaye today.")).not.toContain("name");
  });

  it("handles hyphenated, punctuated and regex-special names safely", () => {
    expect(textsOf("Grace Hopper-Byron called.", "name")).toEqual(["Grace Hopper-Byron"]);

    // Regex metacharacters in host-supplied names must be escaped, not
    // compiled: `.` must not become "any character".
    const escaped = buildNameMatcher(["J. R. Smith", "D* E+"]);
    expect(escaped).not.toBeNull();
    expect(scanText("J. R. Smith called.", { nameMatcher: escaped })).toEqual([
      expect.objectContaining({ dataClass: "name", text: "J. R. Smith" }),
    ]);
    expect(scanText("JxRxSmith called.", { nameMatcher: escaped })).toEqual([]);
  });

  it("returns no matcher for an empty or single-word dictionary", () => {
    expect(buildNameMatcher([])).toBeNull();
    expect(buildNameMatcher(["Cher"])).toBeNull();
  });

  it("does not match a token as a name", () => {
    const tokenish = buildNameMatcher(["Tok Name"]);
    expect(scanText("tok_name_1a2b3c4d", { nameMatcher: tokenish })).toEqual([]);
  });
});

/**
 * Bare given and family names — the leak found in live testing. A seeded note
 * reading "Reached Tricia by phone" left the first name in the clear while the
 * same patient's full name tokenized, which is all a model needs to reassemble
 * the identity the guard just protected.
 *
 * Three properties are load-bearing and each has its own test below: the bare
 * hit resolves to the *full* name (so it mints the same token), an ambiguous
 * fragment is left alone, and matching is case-sensitive so ordinary English
 * words that happen to be names survive.
 */
describe("dictionary pass — bare given and family names", () => {
  /** The span the dictionary pass produced for `text`, if there was one. */
  function nameSpanIn(text: string, names: readonly string[] = NAMES): Span | undefined {
    return scanText(text, { nameMatcher: buildNameMatcher(names) }).find(
      (span) => span.dataClass === "name",
    );
  }

  it("matches a bare first name and resolves it to the full name", () => {
    const span = nameSpanIn("Reached Tricia by phone to confirm.");
    expect(span).toMatchObject({ text: "Tricia", identity: "Tricia Bashirian" });
  });

  it("matches a bare last name and resolves it to the full name", () => {
    const span = nameSpanIn("Bashirian asked about refills.");
    expect(span).toMatchObject({ text: "Bashirian", identity: "Tricia Bashirian" });
  });

  it("matches a middle name too, which leaks exactly as readily", () => {
    const span = nameSpanIn("Spoke to Quinn about the referral.", ["Dana Quinn Halloran"]);
    expect(span).toMatchObject({ text: "Quinn", identity: "Dana Quinn Halloran" });
  });

  it("resolves an honorific form to the full name as well", () => {
    expect(nameSpanIn("Ms. Bashirian asked about refills.")).toMatchObject({
      text: "Ms. Bashirian",
      identity: "Tricia Bashirian",
    });
    expect(nameSpanIn("Dr Whitfield reviewed the chart.")).toMatchObject({
      text: "Dr Whitfield",
      identity: "Ada Whitfield",
    });
  });

  it("resolves a lower-cased full name to the dictionary's own spelling", () => {
    expect(nameSpanIn("spoke with tricia bashirian today.")).toMatchObject({
      text: "tricia bashirian",
      identity: "Tricia Bashirian",
    });
  });

  it("leaves a bare name alone when two people in the dictionary share it", () => {
    const shared = ["Tricia Bashirian", "Tricia Okonkwo"];

    // Ambiguous first name: no single right token to mint, so nothing is done.
    expect(nameSpanIn("Reached Tricia by phone.", shared)).toBeUndefined();

    // The unambiguous halves of the same dictionary still match.
    expect(nameSpanIn("Bashirian asked about refills.", shared)).toMatchObject({
      text: "Bashirian",
      identity: "Tricia Bashirian",
    });
    // ...and a full name is never affected by the ambiguity of its parts. It
    // carries no `identity` because the matched text already *is* the value.
    const full = nameSpanIn("Tricia Okonkwo called.", shared);
    expect(full).toMatchObject({ text: "Tricia Okonkwo" });
    expect(full?.identity).toBeUndefined();
  });

  it("counts one person listed twice as one owner, not as an ambiguity", () => {
    expect(
      nameSpanIn("Reached Tricia by phone.", ["Tricia Bashirian", "tricia bashirian"]),
    ).toMatchObject({
      text: "Tricia",
      identity: "Tricia Bashirian",
    });
  });

  it("still matches an honorific form whose surname is shared, without inventing an identity", () => {
    const shared = ["Ada Bashirian", "Tricia Bashirian"];
    const span = nameSpanIn("Ms. Bashirian asked about refills.", shared);

    // An honorific in front of a known surname is a person whichever one it is,
    // so it is still replaced — it just tokenizes its own text.
    expect(span).toMatchObject({ text: "Ms. Bashirian" });
    expect(span?.identity).toBeUndefined();
  });

  it("is case-sensitive: the boat is not the patient", () => {
    const names = ["Dock Bode"];
    expect(nameSpanIn("Dock is due for a follow-up.", names)).toMatchObject({
      text: "Dock",
      identity: "Dock Bode",
    });
    expect(nameSpanIn("Told the family to dock the boat before the storm.", names)).toBeUndefined();
    expect(nameSpanIn("Patient works at the DOCK on weekends.", names)).toBeUndefined();
  });

  it("requires whole-word boundaries", () => {
    expect(nameSpanIn("Triciana Bashirianopoulos is a different person.")).toBeUndefined();
    expect(nameSpanIn("unTricia is not a word, but it is not a name either.")).toBeUndefined();
  });

  it("prefers the longest match: a full name never splits into fragments", () => {
    const spans = scanText("Tricia Bashirian called.", { nameMatcher: buildNameMatcher(NAMES) });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ text: "Tricia Bashirian", start: 0, end: 16 });

    // Same for the honorific form.
    const honorific = scanText("Ms. Bashirian called.", { nameMatcher: buildNameMatcher(NAMES) });
    expect(honorific).toHaveLength(1);
    expect(honorific[0]).toMatchObject({ text: "Ms. Bashirian" });
  });

  it("finds every person in a sentence that mixes all three forms", () => {
    const spans = scanText("Tricia Bashirian saw Ms. Whitfield; Tricia will call Ada back.", {
      nameMatcher: buildNameMatcher(NAMES),
    });

    expect(spans.map((span) => span.text)).toEqual([
      "Tricia Bashirian",
      "Ms. Whitfield",
      "Tricia",
      "Ada",
    ]);
    expect(spans.map((span) => span.identity)).toEqual([
      undefined,
      "Ada Whitfield",
      "Tricia Bashirian",
      "Ada Whitfield",
    ]);
  });

  it("keeps a higher-precedence detector's claim on overlapping text", () => {
    // The e-mail contains both halves of the name; e-mail outranks name.
    const spans = scanText("Write to Tricia.Bashirian@example.com about it.", {
      nameMatcher: buildNameMatcher(NAMES),
    });
    expect(spans.map((span) => span.dataClass)).toEqual(["email"]);
  });

  it("builds no bare pattern from initials, symbols or lower-case entries", () => {
    // "J." and "R." are not names on their own; "D*"/"E+" are not names at all;
    // an all-lower-case entry has no capitalised form to match.
    const matcher = buildNameMatcher(["J. R. Smith", "D* E+", "quiet person"]);
    expect(matcher).not.toBeNull();
    expect(matcher?.bare?.source).not.toContain("J\\.");
    expect(matcher?.bare?.source).not.toContain("D\\*");
    expect(nameSpanIn("quiet was the word for it.", ["quiet person"])).toBeUndefined();

    // "Smith" is a real bare surname and does qualify.
    expect(nameSpanIn("Smith rescheduled.", ["J. R. Smith"])).toMatchObject({
      text: "Smith",
      identity: "J. R. Smith",
    });
  });

  it("has no bare pattern at all when nothing in the dictionary qualifies", () => {
    expect(buildNameMatcher(["tricia bashirian"])?.bare).toBeNull();
  });

  it("resolves nothing for text that is not in the dictionary", () => {
    const matcher = buildNameMatcher(NAMES);
    expect(matcher?.resolve("Marvin Gaye")).toBeNull();
    expect(matcher?.resolve("")).toBeNull();
    expect(matcher?.resolve("Dr. ")).toBeNull();
  });
});

describe("overlap resolution", () => {
  it("prefers the higher-precedence class when two detectors collide", () => {
    // An SSN sits inside the digits a naive card scan would grab; SSN wins.
    const spans = scanText("SSN 900-12-3456 on file.");
    expect(spans.map((span) => span.dataClass)).toEqual(["ssn"]);
  });

  it("returns spans in document order", () => {
    const spans = scanText(
      "Tricia Bashirian, MRN LM-100001, SSN 900-12-3456, phone (206) 555-0142.",
      { nameMatcher: matcher },
    );
    const starts = spans.map((span: Span) => span.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(spans.map((span) => span.dataClass)).toEqual(["name", "mrn", "ssn", "phone"]);
  });
});

describe("the walk", () => {
  it("classifies structured fields by key and free text by detector", () => {
    const classes = classesIn(
      {
        patients: [
          {
            mrn: "LM-100001",
            name: "Tricia Bashirian",
            dob: "1985-04-12",
            addressCity: "Portland",
          },
        ],
        summary: "1 patient returned.",
      },
      { names: NAMES },
    );

    expect(classes).toEqual(["mrn", "name", "dob", "address"]);
  });

  it("reports free_text_phi alongside whatever the spans were", () => {
    const classes = classesIn(
      { body: "Tricia Bashirian (DOB 1985-04-12) called from (206) 555-0142." },
      { names: NAMES },
    );

    expect(classes).toEqual(["name", "dob", "phone", "free_text_phi"]);
  });

  it("does not report free_text_phi for a clean string", () => {
    expect(classesIn({ body: "Blood pressure 128/82. Continuing lisinopril." })).toEqual([]);
  });

  it("does not re-scan a value a key already claimed", () => {
    // The whole field is a name; it must not also be reported as free text.
    const { root } = classify({ name: "Tricia Bashirian" }, { names: NAMES });
    expect(root.kind).toBe("object");
    if (root.kind !== "object") throw new Error("expected an object");
    const node = root.entries[0].node;
    expect(node).toMatchObject({ kind: "string", fieldClass: "name", spans: [] });
  });

  it("hands an array's key down to its items", () => {
    expect(classesIn({ phones: ["(206) 555-0142", "312-555-0187"] })).toEqual(["phone"]);
  });

  it("pulls in numbers only when a key claimed them", () => {
    const { root } = classify({ addressZip: 97201, limit: 25 });
    if (root.kind !== "object") throw new Error("expected an object");
    expect(root.entries[0].node).toMatchObject({ kind: "string", fieldClass: "address" });
    expect(root.entries[1].node).toEqual({ kind: "primitive", value: 25 });
  });

  it("collects city/state siblings for the address contextualizer", () => {
    const { root } = classify({
      addressStreet: "123 Elm St",
      addressCity: "Portland",
      addressState: "OR",
    });
    if (root.kind !== "object") throw new Error("expected an object");
    expect(root.entries[0].node).toMatchObject({ place: { city: "Portland", state: "OR" } });
  });

  it("walks a bare string, a bare array and a bare number at the root", () => {
    expect(classesIn("Call (206) 555-0142.")).toEqual(["phone", "free_text_phi"]);
    expect(classesIn(["SSN 900-12-3456"])).toEqual(["ssn", "free_text_phi"]);
    expect(classesIn(42)).toEqual([]);
    expect(classesIn(null)).toEqual([]);
  });

  it("reports classes in the canonical DATA_CLASSES order", () => {
    const classes = classesIn({
      email: "a@b.com",
      ssn: "900-12-3456",
      name: "Ada Whitfield",
      mrn: "LM-100001",
    });
    expect(classes).toEqual(["ssn", "mrn", "name", "email"]);
  });
});
