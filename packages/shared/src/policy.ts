import { z } from "zod";

import { DataClassSchema, TransformActionSchema } from "./data-class";

/**
 * Policy model for WebMCP Guard (`docs/04-sdk-requirements.md`).
 *
 * A policy is an ordered list of rules; the engine walks them by priority and
 * the first match per aspect wins, over a default-allow-and-log baseline.
 * Deny-by-default is a document-level flag, not the default.
 */

/**
 * Which tools a rule applies to: an explicit name list, or a tag set matched
 * against the `tags` a developer passed to `guard.registerTool`.
 */
export const ToolMatcherSchema = z.union([
  // `.min(1)` matters: an empty list would mean "matches no tool", but the
  // console's builder round-trips it to an omitted matcher — "matches every
  // tool". Refusing the empty list keeps those two meanings from colliding.
  z.array(z.string().min(1)).min(1),
  z.object({ tags: z.array(z.string().min(1)).min(1) }).strict(),
]);

export type ToolMatcher = z.infer<typeof ToolMatcherSchema>;

/**
 * Environment matchers. Agent identity is a best-effort, spoofable signal
 * (see the threat model in `docs/03-architecture.md`) — these are advisory
 * inputs to a policy decision, never an authentication mechanism.
 */
export const AgentMatcherSchema = z.discriminatedUnion("kind", [
  /** Matches when no agent could be identified at all. */
  z.object({ kind: z.literal("unknown") }).strict(),
  /** Matches a specific best-effort agent id, e.g. "chatgpt-atlas". */
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }).strict(),
  /** Matches a browser brand, optionally constrained to a major-version range. */
  z
    .object({
      kind: z.literal("browser"),
      brand: z.string().min(1),
      minVersion: z.number().int().nonnegative().optional(),
      maxVersion: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export type AgentMatcher = z.infer<typeof AgentMatcherSchema>;

/** All matchers are ANDed; an omitted matcher means "don't care". */
export const RuleMatchSchema = z
  .object({
    apps: z.array(z.string().min(1)).min(1).optional(),
    tools: ToolMatcherSchema.optional(),
    agents: z.array(AgentMatcherSchema).min(1).optional(),
    roles: z.array(z.string().min(1)).min(1).optional(),
    dataClasses: z.array(DataClassSchema).min(1).optional(),
  })
  .strict();

export type RuleMatch = z.infer<typeof RuleMatchSchema>;

/**
 * Per-class transform matrix. Every data class is present in the parsed value;
 * omitted classes default to `passthrough`, so policy authors (and the console
 * JSON escape hatch) only have to spell out what they are changing.
 */
const perClassField = TransformActionSchema.default("passthrough");

export const PerClassTransformSchema = z
  .object({
    ssn: perClassField,
    mrn: perClassField,
    name: perClassField,
    dob: perClassField,
    phone: perClassField,
    email: perClassField,
    address: perClassField,
    insurance_id: perClassField,
    credit_card: perClassField,
    free_text_phi: perClassField,
  })
  .strict();

/** `Record<DataClass, TransformAction>` — fully populated after parsing. */
export type PerClassTransform = z.infer<typeof PerClassTransformSchema>;

/** The partial shape a policy author may write. */
export type PerClassTransformInput = z.input<typeof PerClassTransformSchema>;

export const RuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allow") }).strict(),
  z.object({ type: z.literal("deny"), message: z.string().min(1) }).strict(),
  z.object({ type: z.literal("require-confirmation"), message: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("require-justification"),
      minChars: z.number().int().positive().optional(),
      llmEvaluate: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("transform"), perClass: PerClassTransformSchema }).strict(),
]);

export type RuleAction = z.infer<typeof RuleActionSchema>;
export type RuleActionType = RuleAction["type"];

export const RuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    /** Lower runs first. Ties fall back to array order. */
    priority: z.number().int(),
    match: RuleMatchSchema,
    action: RuleActionSchema,
  })
  .strict();

export type Rule = z.infer<typeof RuleSchema>;
export type RuleInput = z.input<typeof RuleSchema>;

/** Current policy document version. Bump when the rule shape changes. */
export const POLICY_VERSION = 1 as const;

export const PolicyDocumentSchema = z
  .object({
    version: z.literal(POLICY_VERSION),
    /** Baseline when no rule matches. The demo stays permissive. */
    defaultAction: z.enum(["allow", "deny"]).default("allow"),
    rules: z.array(RuleSchema),
  })
  .strict();

export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
export type PolicyDocumentInput = z.input<typeof PolicyDocumentSchema>;
