import {
  PerClassTransformSchema,
  type PerClassTransformInput,
  type VaultEntry,
} from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { createTokenizer } from "./tokenize";
import { MASK_GLYPH, ageBracket, maskValue, transformValue } from "./transform";

/**
 * The four-action matrix (`docs/04`) applied to a realistic nested payload, and
 * the free-text span replacement that makes visit notes safe
 * (`docs/05`: "note text is scanned on the way in too").
 */

const NOW = new Date("2026-08-29T00:00:00.000Z");
const NAMES = ["Tricia Bashirian", "Ada Whitfield"];

const tokenizer = createTokenizer({ orgSecret: "org-secret", vaultKey: "vault-key" });

function matrix(input: PerClassTransformInput) {
  return PerClassTransformSchema.parse(input);
}

/** The policy `docs/05` ships as default rule 1. */
const SHIPPED_MATRIX = matrix({
  ssn: "tokenize",
  mrn: "tokenize",
  name: "tokenize",
  insurance_id: "tokenize",
  dob: "contextualize",
  address: "contextualize",
});

function run(value: unknown, perClass: ReturnType<typeof matrix> | null) {
  return transformValue(value, {
    perClass,
    tokenizer,
    classifier: { names: NAMES },
    now: NOW,
  });
}

/** A search result shaped the way the portal's tools return one. */
function payload() {
  return {
    summary: "1 patient returned of 21 matching.",
    patients: [
      {
        mrn: "LM-100001",
        name: "Tricia Bashirian",
        dob: "1985-04-12",
        ssn: "927-78-1337",
        phone: "(206) 555-0142",
        email: "tricia.bashirian1@example.com",
        addressStreet: "123 Elm St",
        addressCity: "Portland",
        addressState: "OR",
        addressZip: "97201",
        insuranceMemberId: "ABC123456789",
        primaryConditions: ["Hypertension", "Migraine"],
        nextAppointmentAt: "2026-09-03T15:00:00.000Z",
      },
    ],
    notes: [
      {
        author: "Dr. Alicia Reyes",
        body:
          "Tricia Bashirian (DOB 1985-04-12, MRN LM-100001) seen today. " +
          "Reached her at (206) 555-0142; e-mail tricia.bashirian1@example.com.",
      },
    ],
  };
}

describe("no transform rule matched", () => {
  it("returns the result untouched but still reports what was in it", () => {
    const input = payload();
    const outcome = run(input, null);

    expect(outcome.result).toBe(input);
    expect(outcome.vaultEntries).toEqual([]);
    expect(outcome.classesFound).toContain("ssn");
    expect(outcome.classesFound).toContain("free_text_phi");
  });
});

describe("the shipped default matrix", () => {
  const outcome = run(payload(), SHIPPED_MATRIX);
  const result = outcome.result as ReturnType<typeof payload>;
  const patient = result.patients[0];

  it("tokenizes identity, contextualizes dob and address, passes the rest through", () => {
    expect(patient.mrn).toMatch(/^tok_mrn_[0-9a-f]{8}$/);
    expect(patient.name).toMatch(/^tok_name_[0-9a-f]{8}$/);
    expect(patient.ssn).toMatch(/^tok_ssn_[0-9a-f]{8}$/);
    expect(patient.insuranceMemberId).toMatch(/^tok_insurance_id_[0-9a-f]{8}$/);

    expect(patient.dob).toBe("age 40-49");
    expect(patient.addressStreet).toBe("Portland, OR");
    expect(patient.addressCity).toBe("Portland");
    expect(patient.addressState).toBe("OR");
    expect(patient.addressZip).toBe("972**");

    // docs/05: the guard is not redaction-happy. Clinical and scheduling data
    // that policy did not name comes back in the clear.
    expect(patient.phone).toBe("(206) 555-0142");
    expect(patient.email).toBe("tricia.bashirian1@example.com");
    expect(patient.primaryConditions).toEqual(["Hypertension", "Migraine"]);
    expect(patient.nextAppointmentAt).toBe("2026-09-03T15:00:00.000Z");
    expect(result.summary).toBe("1 patient returned of 21 matching.");
  });

  it("replaces spans inside free text using each span's own class", () => {
    const body = result.notes[0].body;

    expect(body).not.toContain("Tricia Bashirian");
    expect(body).toMatch(/^tok_name_[0-9a-f]{8} \(DOB age 40-49, MRN tok_mrn_[0-9a-f]{8}\)/);
    // `phone` is passthrough in this matrix, so the number inside the note stays.
    expect(body).toContain("(206) 555-0142");
    expect(body).toContain("tricia.bashirian1@example.com");
    expect(body).toContain("seen today.");
  });

  it("mints the same token for a value whether it came from a field or from prose", () => {
    expect(result.notes[0].body).toContain(patient.mrn);
  });

  it("reports every class it found", () => {
    expect(outcome.classesFound).toEqual([
      "ssn",
      "mrn",
      "name",
      "dob",
      "phone",
      "email",
      "address",
      "insurance_id",
      "free_text_phi",
    ]);
  });

  it("emits one vault row per distinct token", () => {
    const tokens = outcome.vaultEntries.map((entry: VaultEntry) => entry.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const entry of outcome.vaultEntries) {
      expect(tokenizer.open(entry)).not.toBeNull();
    }
    // The MRN appears in both the field and the note, but is stored once.
    expect(tokens.filter((token) => token.startsWith("tok_mrn_"))).toHaveLength(1);
  });

  it("never mutates the input", () => {
    const input = payload();
    const before = JSON.stringify(input);
    run(input, SHIPPED_MATRIX);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("mask", () => {
  const masked = run(
    payload(),
    matrix({
      ssn: "mask",
      phone: "mask",
      email: "mask",
      name: "mask",
      mrn: "mask",
      credit_card: "mask",
    }),
  ).result as ReturnType<typeof payload>;

  it("keeps the last four digits of an SSN, phone and card", () => {
    expect(masked.patients[0].ssn).toBe("•••-••-1337");
    expect(masked.patients[0].phone).toBe("(•••) •••-0142");
    expect(maskValue("4111 1111 1111 1111", "credit_card")).toBe("•••• •••• •••• 1111");
  });

  it("keeps the domain but not the mailbox of an e-mail", () => {
    expect(masked.patients[0].email).toBe("t•••@example.com");
  });

  it("falls back to a generic glyph for classes with no digit convention", () => {
    expect(masked.patients[0].name).toBe(MASK_GLYPH);
    expect(maskValue("no digits here", "ssn")).toBe(MASK_GLYPH);
    expect(maskValue("not-an-email", "email")).toBe(MASK_GLYPH);
  });

  it("masks spans inside free text too", () => {
    expect(masked.notes[0].body).toContain(MASK_GLYPH);
    expect(masked.notes[0].body).toContain("(•••) •••-0142");
    expect(masked.notes[0].body).not.toContain("Tricia Bashirian");
  });
});

describe("contextualize", () => {
  it("brackets an age by decade", () => {
    expect(ageBracket("1985-04-12", NOW)).toBe("age 40-49");
    expect(ageBracket("1976-01-01", NOW)).toBe("age 50-59");
    expect(ageBracket("4/12/1985", NOW)).toBe("age 40-49");
  });

  it("caps the top bracket at 90+ and floors the bottom at under 10", () => {
    expect(ageBracket("1930-01-01", NOW)).toBe("age 90+");
    expect(ageBracket("2020-01-01", NOW)).toBe("under 10");
  });

  it("counts a birthday that has not happened yet as the previous year", () => {
    expect(ageBracket("1986-08-30", NOW)).toBe("age 30-39");
    expect(ageBracket("1986-08-28", NOW)).toBe("age 40-49");
  });

  it("falls back to tokenizing a date it cannot parse", () => {
    const outcome = run({ dob: "sometime in the eighties" }, matrix({ dob: "contextualize" }));
    expect((outcome.result as { dob: string }).dob).toMatch(/^tok_dob_[0-9a-f]{8}$/);
    expect(outcome.vaultEntries).toHaveLength(1);
  });

  it("derives City, ST from a one-line address when there are no siblings", () => {
    const outcome = run(
      { address: "123 Elm St, Portland, OR 97201" },
      matrix({ address: "contextualize" }),
    );
    expect((outcome.result as { address: string }).address).toBe("Portland, OR");
  });

  it("falls back to tokenizing an address it cannot place", () => {
    const outcome = run(
      { address: "somewhere near the lake" },
      matrix({ address: "contextualize" }),
    );
    expect((outcome.result as { address: string }).address).toMatch(/^tok_address_[0-9a-f]{8}$/);
  });

  it("tokenizes classes that have no contextualizer at all", () => {
    const outcome = run({ ssn: "927-78-1337" }, matrix({ ssn: "contextualize" }));
    expect((outcome.result as { ssn: string }).ssn).toMatch(/^tok_ssn_[0-9a-f]{8}$/);
  });
});

describe("free_text_phi as a whole-field action", () => {
  it("passthrough leaves span replacement to each span's own class", () => {
    const outcome = run(payload(), matrix({ name: "tokenize", free_text_phi: "passthrough" }));
    const body = (outcome.result as ReturnType<typeof payload>).notes[0].body;

    expect(body).toMatch(/^tok_name_[0-9a-f]{8} \(DOB 1985-04-12/);
  });

  it("a non-passthrough action replaces the whole field instead", () => {
    const tokenized = run(payload(), matrix({ free_text_phi: "tokenize" }));
    const body = (tokenized.result as ReturnType<typeof payload>).notes[0].body;
    expect(body).toMatch(/^tok_free_text_phi_[0-9a-f]{8}$/);

    const maskedOutcome = run(payload(), matrix({ free_text_phi: "mask" }));
    expect((maskedOutcome.result as ReturnType<typeof payload>).notes[0].body).toBe(MASK_GLYPH);
  });

  it("leaves a clean free-text field alone whatever free_text_phi says", () => {
    const outcome = run({ body: "Blood pressure 128/82." }, matrix({ free_text_phi: "tokenize" }));
    expect((outcome.result as { body: string }).body).toBe("Blood pressure 128/82.");
  });
});

/**
 * The identity rule: a bare dictionary hit tokenizes the *person*, not the
 * fragment. If "Tricia" and "Tricia Bashirian" hashed differently, an agent
 * could no longer tell the note and the chart are about one patient — which is
 * the only reason the tokens are deterministic in the first place.
 */
describe("bare names in free text", () => {
  const NAME_ONLY = matrix({ name: "tokenize" });

  function bodyOf(outcome: ReturnType<typeof run>): string {
    return (outcome.result as { name: string; body: string }).body;
  }

  it("mints the same token for a bare first name as for the full name", () => {
    const outcome = run(
      { name: "Tricia Bashirian", body: "Reached Tricia by phone to confirm." },
      NAME_ONLY,
    );
    const result = outcome.result as { name: string; body: string };

    expect(result.name).toMatch(/^tok_name_[0-9a-f]{8}$/);
    expect(result.body).toBe(`Reached ${result.name} by phone to confirm.`);
  });

  it("mints the same token for a bare last name", () => {
    const outcome = run({ name: "Tricia Bashirian", body: "Bashirian rescheduled." }, NAME_ONLY);
    const result = outcome.result as { name: string; body: string };

    expect(result.body).toBe(`${result.name} rescheduled.`);
  });

  it("resolves a full name, a bare name and an honorific to one identical token", () => {
    const outcome = run(
      {
        name: "Tricia Bashirian",
        body:
          "Tricia Bashirian was seen today. Reached Tricia by phone afterwards; " +
          "Ms. Bashirian will call back. tricia bashirian is also on the waitlist.",
      },
      NAME_ONLY,
    );
    const result = outcome.result as { name: string; body: string };
    const tokens = [...bodyOf(outcome).matchAll(/tok_name_[0-9a-f]{8}/g)].map((hit) => hit[0]);

    expect(tokens).toHaveLength(4);
    expect(new Set(tokens)).toEqual(new Set([result.name]));
    expect(result.body).not.toMatch(/Tricia|Bashirian|tricia|bashirian/);
    // One person, one vault row, whatever the note called them.
    expect(outcome.vaultEntries).toHaveLength(1);
    expect(tokenizer.open(outcome.vaultEntries[0])).toBe("Tricia Bashirian");
  });

  it("leaves an ambiguous bare first name in the clear", () => {
    const outcome = transformValue(
      { body: "Reached Tricia by phone." },
      {
        perClass: NAME_ONLY,
        tokenizer,
        classifier: { names: ["Tricia Bashirian", "Tricia Okonkwo"] },
        now: NOW,
      },
    );

    expect(bodyOf(outcome)).toBe("Reached Tricia by phone.");
    expect(outcome.classesFound).toEqual([]);
    expect(outcome.actionsApplied).toEqual([]);
  });

  it("leaves a lower-case homograph of a patient name alone", () => {
    const outcome = transformValue(
      { body: "Told the family to dock the boat before the storm." },
      { perClass: NAME_ONLY, tokenizer, classifier: { names: ["Dock Bode"] }, now: NOW },
    );

    expect(bodyOf(outcome)).toBe("Told the family to dock the boat before the storm.");
    expect(outcome.actionsApplied).toEqual([]);
  });

  it("still tokenizes the same patient when their name is capitalised as a word", () => {
    const outcome = transformValue(
      { body: "Dock is due for a follow-up." },
      { perClass: NAME_ONLY, tokenizer, classifier: { names: ["Dock Bode"] }, now: NOW },
    );

    expect(bodyOf(outcome)).toMatch(/^tok_name_[0-9a-f]{8} is due for a follow-up\.$/);
    expect(tokenizer.open(outcome.vaultEntries[0])).toBe("Dock Bode");
  });

  it("masks a bare name without leaking which name it was", () => {
    const outcome = run({ body: "Reached Tricia by phone." }, matrix({ name: "mask" }));
    expect(bodyOf(outcome)).toBe(`Reached ${MASK_GLYPH} by phone.`);
    expect(outcome.actionsApplied).toEqual(["mask"]);
  });
});

/**
 * `actionsApplied` drives the agent-facing privacy notice, so it has to be
 * literally true: the mechanisms that *replaced* something on this result, and
 * nothing else.
 */
describe("actionsApplied", () => {
  it("is empty when no transform rule matched", () => {
    expect(run(payload(), null).actionsApplied).toEqual([]);
  });

  it("is empty when a matched matrix changed nothing", () => {
    const outcome = run({ patients: [{ mrn: "LM-100001" }] }, matrix({ name: "tokenize" }));
    expect(outcome.result).toEqual({ patients: [{ mrn: "LM-100001" }] });
    expect(outcome.actionsApplied).toEqual([]);
  });

  it("does not count a contextualizer that returned its own input", () => {
    // City and state *are* the contextualized granularity, so this is a no-op.
    const outcome = run(
      { addressCity: "Portland", addressState: "OR" },
      matrix({ address: "contextualize" }),
    );
    expect(outcome.result).toEqual({ addressCity: "Portland", addressState: "OR" });
    expect(outcome.actionsApplied).toEqual([]);
  });

  it("reports each mechanism exactly once, in a stable order", () => {
    const outcome = run(
      payload(),
      matrix({ name: "tokenize", mrn: "tokenize", email: "mask", dob: "contextualize" }),
    );
    expect(outcome.actionsApplied).toEqual(["tokenize", "mask", "contextualize"]);
  });

  it.each([
    ["tokenize", matrix({ ssn: "tokenize" }), ["tokenize"]],
    ["mask", matrix({ ssn: "mask" }), ["mask"]],
    ["contextualize", matrix({ dob: "contextualize" }), ["contextualize"]],
  ])("reports only %s when that is all that ran", (_label, perClass, expected) => {
    const outcome = run({ ssn: "927-78-1337", dob: "1985-04-12" }, perClass);
    expect(outcome.actionsApplied).toEqual(expected);
  });

  it("reports tokenize, not contextualize, when a contextualizer fell back", () => {
    const outcome = run({ dob: "sometime in the eighties" }, matrix({ dob: "contextualize" }));
    expect(outcome.actionsApplied).toEqual(["tokenize"]);
  });
});

describe("shape preservation", () => {
  it("keeps key order, arrays, nulls and untouched numbers", () => {
    const outcome = run(
      { limit: 25, tags: ["a", "b"], missing: null, ok: true, name: "Ada Whitfield" },
      SHIPPED_MATRIX,
    );
    const result = outcome.result as Record<string, unknown>;

    expect(Object.keys(result)).toEqual(["limit", "tags", "missing", "ok", "name"]);
    expect(result.limit).toBe(25);
    expect(result.tags).toEqual(["a", "b"]);
    expect(result.missing).toBeNull();
    expect(result.ok).toBe(true);
  });

  it("keeps a claimed number a number when its class is passthrough", () => {
    const outcome = run({ addressZip: 97201 }, matrix({ address: "passthrough" }));
    expect((outcome.result as { addressZip: number }).addressZip).toBe(97201);
  });

  it("transforms a bare string result", () => {
    const outcome = run("Chart LM-100001 updated.", SHIPPED_MATRIX);
    expect(outcome.result).toMatch(/^Chart tok_mrn_[0-9a-f]{8} updated\.$/);
  });
});
