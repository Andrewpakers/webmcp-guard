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
 * Two of the four ship **disabled**: the confirmation and justification flows
 * only become real in Phase 5, and shipping them enabled would block judges in
 * a build that cannot yet render the confirmation modal.
 */

/** Ids are stable and readable so log entries and denial messages read well. */
export const DEFAULT_POLICY_RULES: RuleDraft[] = [
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
        // phone, email, credit_card and free_text_phi fall back to passthrough.
      }),
    },
  },
  {
    // Phase 5 enables this one and adds the justification evaluator behind it.
    id: "export-requires-justification",
    name: "Export requires justification",
    enabled: false,
    priority: 20,
    match: { tools: ["export_patients"] },
    action: { type: "require-justification", minChars: 40 },
  },
  {
    // Phase 5 enables this one together with the in-page confirmation modal.
    id: "destructive-requires-confirmation",
    name: "Destructive tools require human confirmation",
    enabled: false,
    priority: 30,
    match: { tools: { tags: ["destructive"] } },
    action: {
      type: "require-confirmation",
      message:
        "Destructive actions on patient records have to be approved by the person using this page.",
    },
  },
  {
    /**
     * TEMP (Phase 2). Stands in for the confirmation flow so the deny path is
     * demonstrably real end to end before Phase 5 exists. Phase 5 deletes this
     * rule and enables `destructive-requires-confirmation` instead.
     */
    id: "delete-patient-deny-temp",
    name: "Delete patient blocked — TEMP (Phase 2)",
    enabled: true,
    priority: 40,
    match: { tools: ["delete_patient"] },
    action: {
      type: "deny",
      message:
        "Deleting patient records from an agent is blocked by organization policy. If this " +
        "record really has to be removed, ask the person you are working with to delete it in " +
        "the portal (Patients → open the record → Delete), where a human confirms the deletion " +
        "and it is audited.",
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
