import { z } from "zod";

/**
 * The classes of sensitive data WebMCP Guard recognises in v1
 * (`docs/04-sdk-requirements.md`). Order is stable and meaningful: the console
 * renders its per-class transform matrix in this order.
 */
export const DATA_CLASSES = [
  "ssn",
  "mrn",
  "name",
  "dob",
  "phone",
  "email",
  "address",
  "insurance_id",
  "credit_card",
  "free_text_phi",
] as const;

export const DataClassSchema = z.enum(DATA_CLASSES);

export type DataClass = z.infer<typeof DataClassSchema>;

/** What the outbound transform does to a value of a given data class. */
export const TRANSFORM_ACTIONS = ["tokenize", "mask", "contextualize", "passthrough"] as const;

export const TransformActionSchema = z.enum(TRANSFORM_ACTIONS);

export type TransformAction = z.infer<typeof TransformActionSchema>;
