import {
  GuardStorageError,
  PerClassTransformSchema,
  type GuardStorage,
  type Rule,
  type RuleDraft,
} from "@webmcp-guard/shared";

/**
 * The policy WebMCP Guard ships with, from `docs/05-demo-app-requirements.md`
 * §"Default shipped policies". Seeded once into an empty store and editable in
 * the console from then on — the seeder never touches a store that already has
 * rules, so an administrator who deletes a default rule keeps it deleted.
 *
 * Enabled: the PHI transform (1), the export justification (2) and the
 * destructive confirmation (3) — Phase 5 makes all three real — plus the Phase 6
 * role rule that hides clinical notes from the billing desk.
 *
 * Disabled: the **posture pack** (4). `docs/05` is explicit that it ships off
 * "so judges' environments aren't blocked", and it is toggled on live in the
 * video. Both rules deny, so shipping them on would be the one change in this
 * repo capable of breaking a judge's session before they see anything.
 */

/** Ids are stable and readable so log entries and denial messages read well. */
export const DEFAULT_POLICY_RULES: RuleDraft[] = [
  /* -- posture pack (docs/05 §4) — DISABLED, ids prefixed `posture-` ------ */
  {
    /**
     * Posture rules run before everything else: an unacceptable environment
     * should fail before the guard reasons about tools or data at all.
     */
    id: "posture-deny-unknown-agent",
    name: "Posture: deny unidentified agents",
    enabled: false,
    priority: 5,
    match: { agents: [{ kind: "unknown" }] },
    action: {
      type: "deny",
      message:
        "This organization only accepts tool calls from agents it can identify, and this call " +
        "arrived without an agent identity. Ask the person using this page to do it in the " +
        "portal themselves, or to run you from an agent this organization recognizes.",
    },
  },
  {
    /**
     * WebMCP shipped in Chrome 149 (behind a flag) — a browser older than that
     * cannot expose the guarded tool channel in the first place, so a call
     * claiming to come from one is either misconfigured or misreporting.
     *
     * The bound is written out as three brand matchers rather than a fuzzy
     * "contains chrome" match: brand comparison is exact (see
     * `sameBrand` in `@webmcp-guard/shared`), which keeps an administrator's
     * rule from silently widening to browsers they never named. Client Hints
     * report "Google Chrome" *and* "Chromium"; the UA fallback reports
     * "HeadlessChrome" for a headless run.
     */
    id: "posture-deny-old-browser",
    name: "Posture: deny browsers older than the WebMCP era",
    enabled: false,
    priority: 6,
    match: {
      agents: [
        // Inclusive bound: 148 and older, i.e. everything before Chrome 149.
        { kind: "browser", brand: "Chromium", maxVersion: 148 },
        { kind: "browser", brand: "Google Chrome", maxVersion: 148 },
        { kind: "browser", brand: "HeadlessChrome", maxVersion: 148 },
      ],
    },
    action: {
      type: "deny",
      message:
        "This browser is older than Chrome 149, which is the minimum this organization allows " +
        "for agent tool calls. Ask the person using this page to update their browser and try " +
        "again, or to perform the action in the portal themselves.",
    },
  },
  {
    /**
     * Role-scoped data control (`docs/07` Phase 6): the billing desk can look a
     * patient up, but has no business reading what the clinician wrote.
     *
     * Sits at priority 8, **ahead of** `phi-transform-default` (10), because the
     * transform aspect takes exactly one rule's matrix — first match wins, and
     * there is no merging of matrices anywhere in the engine. So this rule has
     * to carry the *whole* policy for a billing session, not a delta: every row
     * below is a verbatim copy of `phi-transform-default` except
     * `free_text_phi`, which goes from `passthrough` to `mask`.
     *
     * `free_text_phi: "mask"` is the whole-field switch described in
     * `transform.ts`: any other value than `passthrough` stops per-span
     * replacement and replaces the *entire* free-text value instead. A note body
     * therefore comes back as `▪▪▪` for billing, while demographics keep the
     * same tokenization every other role gets.
     *
     * Scoped to `get_patient` only, which is the one tool that returns note
     * bodies. Widening it to the `phi` tag would also blank `search_patients`
     * summaries, which billing legitimately needs.
     */
    id: "role-billing-notes-masked",
    name: "Billing sees no clinical notes",
    enabled: true,
    priority: 8,
    match: { roles: ["billing"], tools: ["get_patient"] },
    action: {
      type: "transform",
      perClass: PerClassTransformSchema.parse({
        ssn: "tokenize",
        mrn: "tokenize",
        name: "tokenize",
        insurance_id: "tokenize",
        dob: "contextualize",
        address: "contextualize",
        email: "mask",
        // The only line that differs from phi-transform-default.
        free_text_phi: "mask",
        // phone and credit_card fall back to passthrough, as they do there.
      }),
    },
  },
  {
    id: "phi-transform-default",
    name: "Tokenize PHI on phi-tagged tools",
    enabled: true,
    priority: 10,
    match: { tools: { tags: ["phi"] } },
    action: {
      type: "transform",
      perClass: PerClassTransformSchema.parse({
        ssn: "tokenize",
        mrn: "tokenize",
        name: "tokenize",
        insurance_id: "tokenize",
        dob: "contextualize",
        address: "contextualize",
        // Deviation from docs/05 default policy 1 ("passthrough the rest"):
        // emails embed the patient's name (tricia.bashirian27@…), which would
        // undo name tokenization in every get_patient result. Masking keeps
        // the headline honest; flip it live in the console to demo the matrix.
        email: "mask",
        // phone, credit_card and free_text_phi fall back to passthrough.
      }),
    },
  },
  {
    /**
     * The bulk-disclosure gate. `minChars: 40` is the number `docs/05` names;
     * the evaluator behind it lives in `justification.ts`.
     */
    id: "export-requires-justification",
    name: "Export requires justification",
    enabled: true,
    priority: 20,
    match: { tools: ["export_patients"] },
    action: { type: "require-justification", minChars: 40 },
  },
  {
    /**
     * The demo's dramatic beat: the agent asks to delete a patient, the person
     * at the keyboard gets a modal, and whatever they choose is what happens.
     * Tag-scoped, so it covers `delete_patient` and anything else a host tags
     * `destructive` later. It replaces the Phase 2 blanket deny on
     * `delete_patient`, which was deleted when this rule was switched on.
     */
    id: "destructive-requires-confirmation",
    name: "Destructive tools require human confirmation",
    enabled: true,
    priority: 30,
    match: { tools: { tags: ["destructive"] } },
    action: {
      type: "require-confirmation",
      message:
        "Destructive actions on patient records have to be approved by the person using this page.",
    },
  },
];

/**
 * Writes the default rules into an empty store and returns what it created;
 * returns `[]` when the store already holds a policy.
 *
 * Idempotent twice over: the emptiness check stops it on the second boot, and
 * the per-rule `duplicate-rule` guard stops two processes racing to seed the
 * same database from creating doubles.
 */
export async function seedDefaultPolicy(
  storage: GuardStorage,
  rules: RuleDraft[] = DEFAULT_POLICY_RULES,
): Promise<Rule[]> {
  const existing = await storage.listRules();
  if (existing.length > 0) return [];

  const seeded: Rule[] = [];
  for (const draft of rules) {
    try {
      seeded.push(await storage.createRule(draft));
    } catch (error) {
      if (error instanceof GuardStorageError && error.code === "duplicate-rule") continue;
      throw error;
    }
  }
  return seeded;
}
