/**
 * Every string in this file is read by a language model, not by a developer
 * (`docs/04` behavior 6: "errors are content"). They must be actionable prose —
 * no stack traces, no JSON dumps of internal state, no HTTP status codes, and
 * never any fragment of a result that failed to be transformed.
 */

/** Used when a non-allow verdict arrives without a policy message. */
export const BLOCKED_FALLBACK_MESSAGE = "Blocked by policy.";

/** The two round trips that can fail closed. */
export type GuardStage = "gate" | "transform";

/**
 * The fail-closed answer. Returned whenever the guard cannot complete a round
 * trip — network error, non-2xx, or a response that does not match the wire
 * contract. On a `transform` failure this replaces the *untransformed* result,
 * which must never reach the agent.
 */
export function verificationFailedMessage(stage: GuardStage): string {
  return (
    `WebMCP Guard could not verify this call (${stage}): the result was withheld. ` +
    "Try again or ask the user to check the portal."
  );
}

/** Abort is not a failure — say so briefly and stop. */
export const CANCELLED_MESSAGE =
  "WebMCP Guard: the call was cancelled before it finished, so nothing was returned.";

/**
 * The site's own `execute` threw. The reason is deliberately omitted: thrown
 * messages routinely carry internals (SQL, file paths) or the very data the
 * guard exists to keep out of the model's context. The full reason is emitted
 * as a page-local `error` event for the human instead.
 */
export function executeFailedMessage(tool: string): string {
  return (
    `WebMCP Guard: the tool "${tool}" failed while running in the page, so nothing was returned. ` +
    "Try again with different arguments, or ask the user to check the portal for details."
  );
}

/** The agent sent something that is not a JSON object; nothing was run. */
export function invalidArgumentsMessage(tool: string): string {
  return (
    `WebMCP Guard: the arguments for "${tool}" were not a JSON object, so the call was not run. ` +
    "Send an object whose properties match the tool's input schema."
  );
}

/** A tool that ran fine and returned nothing still needs to say something. */
export const EMPTY_RESULT_MESSAGE = "The tool ran successfully and returned no content.";

/**
 * The decline. This string is the demo's dramatic beat (`docs/05` step 4: "the
 * human declines; the agent receives a clean policy explanation"), so it does
 * three things at once: it says *who* decided, it repeats the policy's own
 * explanation so the model has the reason, and it closes the loop — the model
 * should report back, not retry.
 */
export function declinedMessage(policyMessage?: string): string {
  const policy = policyMessage === undefined ? "" : ` ${policyMessage}`;
  return (
    `This call needed human approval and the person at the keyboard declined it, so nothing ` +
    `was done.${policy} Do not try again unless they ask you to — tell them it was declined ` +
    `and ask what they would like instead.`
  );
}

/**
 * The approval was given but the follow-up gate call still refused it (the id
 * expired while the modal was open, the arguments changed, the policy moved).
 * Fail closed and say what happened.
 */
export const APPROVAL_NOT_ACCEPTED_MESSAGE =
  "The person at the keyboard approved this call, but the guard did not accept the approval " +
  "(it may have expired, or the policy may have changed while it was open). Nothing was done. " +
  "Ask them to try again.";

/** No confirmation id arrived with a `require-confirmation` verdict — nothing to approve. */
export const CONFIRMATION_UNAVAILABLE_MESSAGE =
  "This call needs approval from the person using this page, but WebMCP Guard could not open " +
  "the approval prompt, so nothing was done. Ask them to perform the action in the portal.";

/** Printed once per page when there is no WebMCP to register against. */
export const WEBMCP_UNAVAILABLE_WARNING =
  "[WebMCP Guard] WebMCP is not available in this browser, so no tools were registered. " +
  "Enable chrome://flags/#enable-webmcp-testing and relaunch Chrome, or open this page in " +
  "ChatGPT's in-app browser. The page keeps working normally for humans.";
