import type { Rule, TransformAction } from "@webmcp-guard/shared";

import { CONFIRMATION_TTL_MS, type ConfirmationFailure } from "./confirmation";
import { DEFAULT_JUSTIFICATION_MIN_CHARS } from "./justification";
import type { PolicyDecision } from "./policy-engine";

/**
 * Everything an agent reads back from WebMCP Guard is written for a model to
 * act on: what happened, which policy did it, and what to do instead
 * (`docs/04-sdk-requirements.md` → "Errors are content"). No stack traces, no
 * JSON dumps of internal state, no scolding.
 */

function attribution(rule: Rule): string {
  return `${rule.name} (${rule.id})`;
}

/** `Blocked by policy <name> (<id>): <rule message>` — the shape docs/05 promises. */
export function denyMessage(rule: Rule): string {
  const detail =
    rule.action.type === "deny" ? rule.action.message : "This tool call is not allowed.";
  return `Blocked by policy ${attribution(rule)}: ${detail}`;
}

export function confirmationMessage(rule: Rule): string {
  const detail =
    rule.action.type === "require-confirmation"
      ? rule.action.message
      : "This tool call needs human approval.";
  return (
    `Human confirmation required by policy ${attribution(rule)}: ${detail} ` +
    `The call was not executed — ask the person using this page to approve it.`
  );
}

/**
 * What an agent reads when a call needs a justification it did not supply — or
 * supplied badly.
 *
 * Written as an instruction, not a refusal: the model's next turn should be a
 * *better call*, so the message says exactly which argument to add, how long it
 * has to be, and what belongs in it. `reason` is the evaluator's verdict on a
 * justification that was present but rejected.
 */
export function justificationMessage(
  rule: Rule | null,
  minChars: number,
  tool: string,
  reason?: string,
): string {
  const policy = rule === null ? "the default policy" : `policy ${attribution(rule)}`;
  const rejected =
    reason === undefined ? "" : ` The justification you sent was rejected: ${reason}`;
  return (
    `Justification required by ${policy}: call "${tool}" again with a "justification" argument ` +
    `of at least ${minChars} characters explaining why this data is needed and for whom — ` +
    `name the person or team who asked, and what they will do with it.${rejected}`
  );
}

/** Recorded on the audit entry (not shown to the agent) when a justification passes. */
export function justificationAcceptedNote(reason: string): string {
  return `Justification accepted by the evaluator: ${reason}`;
}

/** Recorded when the host's evaluator threw and the heuristic decided instead. */
export const EVALUATOR_FALLBACK_NOTE =
  "The configured justification evaluator failed, so WebMCP Guard fell back to the built-in " +
  "heuristic for this call.";

/**
 * The audit note for a call a person approved in the page. Deliberately says
 * *what* was approved and *how*, so the log entry reads as an accountable human
 * action rather than a policy exception.
 */
export function humanApprovedNote(rule: Rule | null, confirmationId: string): string {
  const policy = rule === null ? "policy" : `policy ${attribution(rule)}`;
  return (
    `Approved in the page by the person using this browser, as ${policy} requires ` +
    `(single-use confirmation ${confirmationId}, now spent).`
  );
}

/** Agent-facing note on the allow that follows an approval. */
export const HUMAN_APPROVED_MESSAGE =
  "The person using this page approved this call, so it ran. The approval was single-use — " +
  "a further call to this tool will ask them again.";

/**
 * Why a presented confirmation id was refused. Every branch ends the call with
 * a `deny`, and every message tells the agent the one thing that works next:
 * ask again and let the person approve a fresh call.
 */
export function confirmationRejectedMessage(failure: ConfirmationFailure, tool: string): string {
  const retry = `Call "${tool}" again to ask the person using this page for a fresh approval.`;

  switch (failure) {
    case "unknown-or-used":
      return (
        `Blocked by policy: that approval has already been used, or was never issued. ` +
        `Human approvals are single-use and cannot be replayed. ${retry}`
      );
    case "expired":
      return (
        `Blocked by policy: that approval expired before it was used. ` +
        `Approvals are valid for ${Math.round(CONFIRMATION_TTL_MS / 1000)} seconds. ${retry}`
      );
    case "arguments-changed":
      return (
        `Blocked by policy: the arguments changed after the person approved this call, so the ` +
        `approval no longer applies. ${retry} Send exactly the arguments you want approved.`
      );
    case "different-call":
      return (
        `Blocked by policy: that approval was issued for a different call. ` +
        `An approval only covers the one tool and the one set of arguments it was shown for. ${retry}`
      );
  }
}

/** The baseline denial, when a deny-by-default document matched no rule at all. */
export function defaultDenyMessage(tool: string): string {
  return (
    `Blocked by the default policy: no rule permits "${tool}" in this application. ` +
    `Ask the person using this page to perform the action in the interface, or ask an ` +
    `administrator to add a policy rule that allows it.`
  );
}

/**
 * What the agent is told about a result the transform rewrote.
 *
 * A model that reads `tok_name_1a2b3c4d` with no explanation does one of two
 * unhelpful things: treats it as corrupt data, or tries to "look up" the real
 * value it already holds a usable handle for. So the guard explains itself
 * in-band, once, on the results it actually changed.
 *
 * Two rules keep this from becoming noise:
 *
 * - **Only what was used.** The sentences are built from the mechanisms that
 *   genuinely replaced something on *this* result. Nothing masked, nothing
 *   about masks.
 * - **Nothing when nothing happened.** An empty mechanism list returns
 *   `undefined`, so a passthrough result reaches the model exactly as the tool
 *   wrote it (`docs/05`: the guard is not redaction-happy — and that applies to
 *   its prose too).
 */
export function transformNotice(
  rule: Rule | null,
  actions: readonly TransformAction[],
): string | undefined {
  const used = new Set(actions.filter((action) => action !== "passthrough"));
  if (used.size === 0) return undefined;

  const by = rule === null ? "a WebMCP Guard policy" : `WebMCP Guard policy ${attribution(rule)}`;
  const sentences = [`Privacy notice: sensitive values in this result were replaced by ${by}.`];

  if (used.has("tokenize")) {
    sentences.push(
      "Strings like tok_name_1a2b3c4d are stable WebMCP Guard tokens — the same person or " +
        "value always yields the same token, so you can compare them across results and pass " +
        "them back into any tool that accepts an identifier.",
    );
  }

  const masked = used.has("mask");
  const generalized = used.has("contextualize");
  if (masked && generalized) {
    sentences.push(
      "Masked values (•••) and generalized values (age brackets, city/state) cannot be recovered.",
    );
  } else if (masked) {
    sentences.push("Masked values (•••) cannot be recovered.");
  } else if (generalized) {
    sentences.push("Generalized values (age brackets, city/state) cannot be recovered.");
  }

  return sentences.join(" ");
}

/**
 * The message that accompanies a non-`allow` verdict. `undefined` for `allow`:
 * a permitted call needs no explanation.
 *
 * The confirmation and justification flows compose richer messages of their own
 * in `/gate` (they know about the minted confirmation id, the evaluator's
 * reason, and the effective minimum length); this is the baseline every verdict
 * falls back to.
 */
export function verdictMessage(
  decision: PolicyDecision,
  tool: string,
  minChars: number = DEFAULT_JUSTIFICATION_MIN_CHARS,
): string | undefined {
  const rule = decision.gateRule;

  switch (decision.verdict) {
    case "allow":
      return undefined;
    case "deny":
      return rule === null ? defaultDenyMessage(tool) : denyMessage(rule);
    case "require-confirmation":
      return rule === null ? undefined : confirmationMessage(rule);
    case "require-justification":
      return justificationMessage(rule, minChars, tool);
  }
}
