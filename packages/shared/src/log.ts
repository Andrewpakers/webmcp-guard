import { z } from "zod";

import { DataClassSchema } from "./data-class";
import { GateVerdictSchema, SessionContextSchema } from "./wire";

/**
 * The audit trail. One entry per agent tool call: what was asked, which rules
 * fired, what the agent actually got back, and how long it took. The console's
 * detail drawer renders `payloads` before/after side by side.
 */

/** Denormalised posture, so a log entry is readable without joining anything. */
export const LogAgentInfoSchema = z
  .object({
    /** Best-effort agent guess. Absent means "unknown agent". */
    agentId: z.string().optional(),
    browserBrand: z.string().optional(),
    browserVersion: z.string().optional(),
    platform: z.string().optional(),
    userAgent: z.string().optional(),
    isSecureContext: z.boolean().optional(),
  })
  .strict();

export type LogAgentInfo = z.infer<typeof LogAgentInfoSchema>;

/**
 * Before/after snapshots for both halves of the pipeline: args as the agent
 * sent them vs. as the site executed them (detokenized), and the raw result vs.
 * the transformed result the agent received.
 */
export const LogPayloadsSchema = z
  .object({
    argsBefore: z.unknown(),
    argsAfter: z.unknown(),
    resultBefore: z.unknown(),
    resultAfter: z.unknown(),
  })
  .strict();

export type LogPayloads = z.infer<typeof LogPayloadsSchema>;

export const LogEntrySchema = z
  .object({
    id: z.string().min(1),
    /** ISO-8601, server clock. */
    timestamp: z.string().datetime(),
    app: z.string().min(1),
    tool: z.string().min(1),
    verdict: GateVerdictSchema,
    agent: LogAgentInfoSchema,
    session: SessionContextSchema.optional(),
    /** Classes the classifier found anywhere in this call. */
    dataClasses: z.array(DataClassSchema),
    /** Ids of the rules that matched, in match order. */
    ruleIds: z.array(z.string()),
    durationMs: z.number().nonnegative(),
    payloads: LogPayloadsSchema,
    /** Supplied by the agent when policy required a justification. */
    justification: z.string().optional(),
    /** The explanation returned to the agent, for non-allow verdicts. */
    message: z.string().optional(),
  })
  .strict();

export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogEntryInput = z.input<typeof LogEntrySchema>;
