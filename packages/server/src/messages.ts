import type { Rule } from "@webmcp-guard/shared";

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

export function justificationMessage(rule: Rule): string {
  const minChars = rule.action.type === "require-justification" ? rule.action.minChars : undefined;
  const length = minChars === undefined ? "" : ` of at least ${minChars} characters`;
  return (
    `Justification required by policy ${attribution(rule)}: call this tool again with a ` +
    `"justification" argument${length} explaining who needs this data and why.`
  );
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
 * The message that accompanies a non-`allow` verdict. `undefined` for `allow`:
 * a permitted call needs no explanation.
 */
export function verdictMessage(decision: PolicyDecision, tool: string): string | undefined {
  const rule = decision.gateRule;

  switch (decision.verdict) {
    case "allow":
      return undefined;
    case "deny":
      return rule === null ? defaultDenyMessage(tool) : denyMessage(rule);
    case "require-confirmation":
      return rule === null ? undefined : confirmationMessage(rule);
    case "require-justification":
      return rule === null ? undefined : justificationMessage(rule);
  }
}
