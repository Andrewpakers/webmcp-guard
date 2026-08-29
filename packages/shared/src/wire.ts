import { z } from "zod";

import { DataClassSchema } from "./data-class";

/**
 * The wire contract between `@webmcp-guard/sdk` (browser) and
 * `@webmcp-guard/server` (Node). One clean, versioned JSON envelope, as
 * required by `docs/03-architecture.md`.
 */

/** Bump only for breaking changes to the payload shapes below. */
export const WIRE_VERSION = 1 as const;

/** A decoded JSON object — tool args and tool results are opaque to the wire. */
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const BrowserBrandSchema = z
  .object({
    brand: z.string(),
    version: z.string(),
  })
  .strict();

/**
 * Best-effort environment signals collected by the SDK. Every field is
 * spoofable; the server decides what to do with them, the client only reports.
 */
export const PostureSnapshotSchema = z
  .object({
    /** `navigator.userAgentData.brands`, when available. */
    brands: z.array(BrowserBrandSchema).optional(),
    platform: z.string().optional(),
    mobile: z.boolean().optional(),
    /** Raw UA string fallback when Client Hints are unavailable. */
    userAgent: z.string().optional(),
    isSecureContext: z.boolean(),
    viewport: z
      .object({
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Best-effort agent guess, e.g. "chatgpt-atlas". Advisory only. */
    agentId: z.string().optional(),
    /** ISO-8601, client clock. */
    timestamp: z.string().datetime(),
  })
  .strict();

export type PostureSnapshot = z.infer<typeof PostureSnapshotSchema>;

/** Identity context the host app supplies via `getSessionContext`. */
export const SessionContextSchema = z
  .object({
    userId: z.string().optional(),
    role: z.string().optional(),
  })
  .strict();

export type SessionContext = z.infer<typeof SessionContextSchema>;

export const GATE_VERDICTS = [
  "allow",
  "deny",
  "require-confirmation",
  "require-justification",
] as const;

export const GateVerdictSchema = z.enum(GATE_VERDICTS);

export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/** `POST /gate` — policy resolution, posture check, inbound detokenization. */
export const GateRequestSchema = z
  .object({
    app: z.string().min(1),
    tool: z.string().min(1),
    args: JsonObjectSchema,
    posture: PostureSnapshotSchema.optional(),
    sessionContext: SessionContextSchema.optional(),
    /** One-time id issued by a previous `require-confirmation` verdict. */
    confirmationId: z.string().min(1).optional(),
  })
  .strict();

export type GateRequest = z.infer<typeof GateRequestSchema>;

export const GateResponseSchema = z
  .object({
    verdict: GateVerdictSchema,
    /** Detokenized args to execute with. Present only when verdict is `allow`. */
    args: JsonObjectSchema.optional(),
    /** Agent-legible explanation. Required in practice for every non-allow verdict. */
    message: z.string().optional(),
    /** Present when verdict is `require-confirmation`. */
    confirmationId: z.string().min(1).optional(),
    /** Ids of the rules that produced this verdict, in match order. */
    ruleIds: z.array(z.string()),
  })
  .strict();

export type GateResponse = z.infer<typeof GateResponseSchema>;

/** `POST /transform` — classify + transform a tool result, then log the call. */
export const TransformRequestSchema = z
  .object({
    app: z.string().min(1),
    tool: z.string().min(1),
    /** Correlates this transform with its earlier gate call for one log entry. */
    callId: z.string().min(1).optional(),
    result: z.unknown(),
  })
  .strict();

export type TransformRequest = z.infer<typeof TransformRequestSchema>;

export const TransformResponseSchema = z
  .object({
    result: z.unknown(),
    classesFound: z.array(DataClassSchema),
    ruleIds: z.array(z.string()),
  })
  .strict();

export type TransformResponse = z.infer<typeof TransformResponseSchema>;

/**
 * Wraps a payload in the versioned envelope every guard request and response
 * travels in: `{ "version": 1, "payload": { ... } }`.
 */
export function wireEnvelope<T extends z.ZodTypeAny>(payload: T) {
  return z
    .object({
      version: z.literal(WIRE_VERSION),
      payload,
    })
    .strict();
}

export const GateRequestEnvelopeSchema = wireEnvelope(GateRequestSchema);
export const GateResponseEnvelopeSchema = wireEnvelope(GateResponseSchema);
export const TransformRequestEnvelopeSchema = wireEnvelope(TransformRequestSchema);
export const TransformResponseEnvelopeSchema = wireEnvelope(TransformResponseSchema);

export type GateRequestEnvelope = z.infer<typeof GateRequestEnvelopeSchema>;
export type GateResponseEnvelope = z.infer<typeof GateResponseEnvelopeSchema>;
export type TransformRequestEnvelope = z.infer<typeof TransformRequestEnvelopeSchema>;
export type TransformResponseEnvelope = z.infer<typeof TransformResponseEnvelopeSchema>;
