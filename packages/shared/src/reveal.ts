import { z } from "zod";

import { DataClassSchema } from "./data-class";

/**
 * `POST /tokens/reveal` — the console's admin-only "show me what is behind
 * this" endpoint (`docs/04-sdk-requirements.md` endpoint table;
 * `docs/06-console-requirements.md` §1: "admin-token gated, **and revealing is
 * itself logged**").
 *
 * Two shapes, one route:
 *
 * - `{ token }` — decrypt one vault entry and return its original value.
 * - `{ logId }` — the console is about to un-mask the before/after payloads it
 *   already holds for that audit entry. Nothing is returned but an
 *   acknowledgement; the point of the call is the audit entry it writes.
 *
 * Both write an audit entry before answering. These schemas live in
 * `@webmcp-guard/shared` for the same reason the wire contract does: the
 * console and the server must not drift.
 */

export const RevealRequestSchema = z
  .object({
    /** A `tok_<class>_<hex8>` token to decrypt. */
    token: z.string().min(1).max(128).optional(),
    /** An audit entry whose stored payloads the console is revealing. */
    logId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((value) => value.token !== undefined || value.logId !== undefined, {
    message: 'Supply "token" (to decrypt one value) or "logId" (to audit a payload reveal).',
  });

export type RevealRequest = z.infer<typeof RevealRequestSchema>;

/** Answer to the `{ token }` form. */
export const RevealTokenResponseSchema = z
  .object({
    token: z.string().min(1),
    dataClass: DataClassSchema,
    /** The original, first-seen spelling of the value. */
    value: z.string(),
  })
  .strict();

export type RevealTokenResponse = z.infer<typeof RevealTokenResponseSchema>;

/** Answer to the `{ logId }` form: proof the reveal was recorded. */
export const RevealLogResponseSchema = z
  .object({
    logId: z.string().min(1),
    acknowledged: z.literal(true),
  })
  .strict();

export type RevealLogResponse = z.infer<typeof RevealLogResponseSchema>;

export const RevealResponseSchema = z.union([RevealTokenResponseSchema, RevealLogResponseSchema]);

export type RevealResponse = z.infer<typeof RevealResponseSchema>;

/**
 * The `app` and `tool` an admin reveal is filed under in the audit log. It is
 * deliberately *not* the host app's id: a reveal is an action by the console
 * operator, not by an agent, and the console's filters should be able to tell
 * the two apart at a glance.
 */
export const REVEAL_LOG_APP = "webmcp-guard" as const;
export const REVEAL_LOG_TOOL = "console_reveal" as const;
