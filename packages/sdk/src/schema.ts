import type { EffectivePolicy } from "@webmcp-guard/shared";

/**
 * Policy-driven schema rewriting (`docs/04` behavior 3: "on registration the
 * SDK fetches effective policy for the tool and injects a required
 * `justification: string` input property when policy says
 * `require-justification`").
 *
 * Why the schema and not just the gate: the gate *is* the enforcement point and
 * always will be — it re-decides every call server-side. But an agent that only
 * learns about the requirement by being refused has to burn a turn discovering
 * it, and models are much better at filling in a declared, described input than
 * at recovering from an error. Injecting the field turns "blocked, try again"
 * into "here is what this call needs", which is the difference between a demo
 * that reads as an obstacle and one that reads as a control.
 *
 * Two rules this module never breaks:
 *
 *  1. **The host's definition is never mutated.** Sites hold onto their tool
 *     definitions (React components re-register the same object across
 *     renders); a guard that edited them in place would leak policy into the
 *     host's own state and double-inject on the second pass.
 *  2. **A missing policy changes nothing.** No answer from the server means the
 *     schema ships exactly as the host wrote it.
 */

/** The property the guard injects, and the server later strips. */
export const JUSTIFICATION_PROPERTY = "justification";

/** Deep copy that never shares structure with the host's object. */
function deepCopy<T>(value: T): T {
  const structured = (globalThis as { structuredClone?: (input: T) => T }).structuredClone;
  if (typeof structured === "function") {
    try {
      return structured(value);
    } catch {
      // Functions and other non-cloneables land here; JSON is the fallback and
      // a JSON Schema is JSON by definition.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The description the agent reads. It has to answer three questions in one
 * breath: why it is being asked, what a good answer looks like, and how long
 * it has to be — otherwise the model writes "because the user asked" and gets
 * refused by the evaluator.
 */
export function justificationDescription(minChars: number | null): string {
  const length =
    minChars === null ? "" : ` It must be at least ${minChars} characters of real explanation.`;
  return (
    "Required by this organization's policy before this tool may run: explain why this data is " +
    "needed and for whom. Name the person or team who asked for it and what they will do with " +
    `it — "because the user asked" is not enough.${length} ` +
    "This text is recorded in the audit log and is not sent to the tool itself."
  );
}

/** True when policy asks for a `justification` argument. */
function requiresJustification(policy: EffectivePolicy | null): boolean {
  return policy !== null && policy.requiresJustification;
}

/**
 * A copy of `inputSchema` with the policy's `justification` property added and
 * marked required. Returns a copy even when nothing changes, so callers never
 * hand the browser an object the host still holds a reference to.
 */
export function applyPolicyToSchema(
  inputSchema: Record<string, unknown>,
  policy: EffectivePolicy | null,
): Record<string, unknown> {
  const schema = deepCopy(inputSchema);
  if (!requiresJustification(policy)) return schema;

  // Adding a property means this is an object schema; say so if the host did
  // not, or `additionalProperties: false` plus a missing `type` would leave the
  // injected field in a schema no validator reads as an object.
  if (typeof schema.type !== "string") schema.type = "object";

  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};

  if (JUSTIFICATION_PROPERTY in properties) {
    // The host already has a `justification` input of its own. Policy wins (the
    // gate is going to strip the field before the tool runs either way), but a
    // developer needs to know their field is being shadowed.
    console.warn(
      `[WebMCP Guard] the tool's inputSchema already declares "${JUSTIFICATION_PROPERTY}"; ` +
        "policy requires that name for its own justification argument, so the guard's " +
        "definition replaces it and the value never reaches the tool.",
    );
  }

  const minChars = policy?.minChars ?? null;
  properties[JUSTIFICATION_PROPERTY] = {
    type: "string",
    ...(minChars === null ? {} : { minLength: minChars }),
    description: justificationDescription(minChars),
  };
  schema.properties = properties;

  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && entry !== JUSTIFICATION_PROPERTY,
      )
    : [];
  schema.required = [...required, JUSTIFICATION_PROPERTY];

  return schema;
}

/**
 * Identifies the *shape* a policy produces, so a refresh can tell a change that
 * needs a re-registration from one that does not.
 *
 * `requiresConfirmation` is deliberately absent: confirmation changes nothing
 * about the schema, so flipping it must not churn every registered tool
 * (re-registration is an abort plus a register — `docs/08` — and each one is a
 * visible `toolchange` event in the browser).
 */
export function schemaSignature(policy: EffectivePolicy | null): string {
  if (policy === null) return "none";
  return `${policy.requiresJustification ? "justify" : "plain"}:${policy.minChars ?? "-"}`;
}
