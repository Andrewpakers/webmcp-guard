import { DATA_CLASSES, TRANSFORM_ACTIONS, type DataClass, type TransformAction } from "@webmcp-guard/shared";

/**
 * Read-only reference copy for the settings page and the transform matrix,
 * mirroring `docs/04-sdk-requirements.md`. It describes what the *server*
 * classifier and tokenizer do; the console never classifies anything itself, so
 * this is documentation, not configuration — hence static text rather than a
 * pretend editor.
 */

export interface DataClassReference {
  dataClass: DataClass;
  label: string;
  description: string;
  example: string;
}

export const DATA_CLASS_REFERENCE: DataClassReference[] = [
  {
    dataClass: "ssn",
    label: "Social security number",
    description: "Field names (ssn, social) and the delimited pattern in free text.",
    example: "123-45-6789",
  },
  {
    dataClass: "mrn",
    label: "Medical record number",
    description: "Field names (mrn, record_number) and the portal's MRN format.",
    example: "LM-100060",
  },
  {
    dataClass: "name",
    label: "Patient name",
    description: "Name fields, plus a dictionary scan for known patient names in free text.",
    example: "Marisol Vandergrift",
  },
  {
    dataClass: "dob",
    label: "Date of birth",
    description: "Birth-date fields and ISO/US dates in DOB-ish contexts.",
    example: "1979-04-12",
  },
  {
    dataClass: "phone",
    label: "Phone number",
    description: "Phone/mobile fields and the North American number pattern.",
    example: "(415) 555-0163",
  },
  {
    dataClass: "email",
    label: "Email address",
    description: "Email fields and the address pattern in any string value.",
    example: "m.vandergrift@example.test",
  },
  {
    dataClass: "address",
    label: "Postal address",
    description: "Address/street/zip fields; contextualizing keeps city and state only.",
    example: "812 Harbor Row, Portland OR",
  },
  {
    dataClass: "insurance_id",
    label: "Insurance id",
    description: "Insurance/member/policy identifier fields.",
    example: "BCX-4471902",
  },
  {
    dataClass: "credit_card",
    label: "Payment card",
    description: "Card-number pattern, confirmed with a Luhn check to kill false positives.",
    example: "4111 1111 1111 1111",
  },
  {
    dataClass: "free_text_phi",
    label: "Free-text PHI",
    description: "Visit notes and other prose: detected spans are replaced in place.",
    example: "Patient reports chest pain since Tuesday…",
  },
];

/**
 * The reference list must cover the shared enum exactly — a class added to
 * `DATA_CLASSES` without copy here would silently vanish from the settings page
 * and the transform matrix. Asserted by `reference.test.ts` rather than at
 * import time, so nothing runs on the client for it.
 */
export function referencedDataClasses(): DataClass[] {
  return DATA_CLASS_REFERENCE.map((entry) => entry.dataClass);
}

export const ALL_DATA_CLASSES = DATA_CLASSES;

export const TRANSFORM_ACTION_HINT: Record<TransformAction, string> = {
  tokenize: "Replace with a deterministic token the agent can pass back to other tools.",
  mask: "Replace with a fixed placeholder. Not reversible, not correlatable.",
  contextualize: "Replace with a useful generalisation — DOB becomes an age bracket.",
  passthrough: "Send the real value. The default for every class a rule does not name.",
};

export const TRANSFORM_ACTION_ORDER = TRANSFORM_ACTIONS;

export const TOKEN_FORMAT = {
  pattern: "tok_<class>_<hex8>",
  example: "tok_ssn_9f2ab3c1",
  notes: [
    "Deterministic: the same value always produces the same token, so an agent can correlate a patient across tools and turns without ever seeing the value.",
    "The hex is an HMAC of the value under GUARD_ORG_SECRET, truncated to 8 characters — not an encoding of the value.",
    "Lowercase ASCII with no punctuation an LLM would mangle when it copies a token between messages.",
    "Detokenization happens server-side only, from the encrypted vault, and only for tools policy permits to receive the real value.",
  ],
} as const;

export const DETECTORS = [
  {
    name: "Field-name pass",
    detail:
      "Walks the JSON payload and maps key patterns (ssn, social, dob|birth, name, phone|mobile, email, address|street|zip, mrn|record_number, insurance) onto data classes. Primary, and the most reliable.",
  },
  {
    name: "Regex pass",
    detail:
      "Scans string values for SSN, phone, email, MRN format, credit cards (Luhn-checked) and ISO/US dates in DOB contexts.",
  },
  {
    name: "Free-text scan",
    detail:
      "Visit notes and prose are classified as free_text_phi with in-place span replacement, plus a dictionary scan against the host app's known patient names.",
  },
] as const;

export const STORAGE_NOTE =
  "The console has no database. Policy, audit log and the token vault all live in the host application's own store behind the GuardStorage adapter — better-sqlite3 in this demo, your database in production.";
