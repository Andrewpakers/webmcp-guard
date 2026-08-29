import {
  brandMajorVersion,
  sameBrand,
  type AgentMatcher,
  type GateVerdict,
  type PerClassTransform,
  type PolicyDocument,
  type PostureSnapshot,
  type Rule,
  type RuleAction,
  type RuleMatch,
} from "@webmcp-guard/shared";

import { postureBrands } from "./posture";

/**
 * The policy engine: an ordered list of rules in, a verdict out
 * (`docs/04-sdk-requirements.md` → "Policy model").
 *
 * Two aspects are resolved independently over the same ordered list, and
 * **first match wins per aspect**:
 *
 * - the **gate aspect** — the first matching rule whose action is `allow`,
 *   `deny`, `require-confirmation` or `require-justification` decides whether
 *   the tool runs at all. With no match, the document's `defaultAction`
 *   (permissive `allow` in the demo) decides.
 * - the **transform aspect** — the first matching rule whose action is
 *   `transform` supplies the per-class matrix the result pipeline applies.
 *
 * The two aspects routinely resolve from *different* rules: the seeded policy
 * tokenizes PHI on every `phi`-tagged tool (transform) while a separate rule
 * denies `delete_patient` (gate).
 */

/** Action types that decide the gate aspect. They map 1:1 onto `GateVerdict`. */
export const GATE_ACTION_TYPES = [
  "allow",
  "deny",
  "require-confirmation",
  "require-justification",
] as const;

/** What the engine knows about a call. Payload classes are not here yet. */
export interface PolicyInput {
  app: string;
  tool: string;
  /** Tags the page attached at registration, e.g. `["read", "phi"]`. */
  toolTags?: string[];
  /** Session role from the host app (`docs/07` Phase 6). */
  role?: string;
  /**
   * The client's environment report, when one was sent. Advisory and spoofable
   * (`docs/03-architecture.md` threat model) — the engine treats it as a
   * *signal*, never as identity.
   */
  posture?: PostureSnapshot;
}

export interface PolicyDecision {
  verdict: GateVerdict;
  /** The rule that decided the verdict, or `null` when the baseline did. */
  gateRule: Rule | null;
  /** The first matching `transform` rule, or `null`. */
  transformRule: Rule | null;
  /** Shorthand for `transformRule?.action.perClass`. */
  perClass: PerClassTransform | null;
  /** Ids of every rule that contributed, in document order. */
  ruleIds: string[];
}

function isGateAction(action: RuleAction): boolean {
  return (GATE_ACTION_TYPES as readonly string[]).includes(action.type);
}

/**
 * Matchers the engine cannot evaluate, and therefore refuses to pretend it can.
 *
 * `dataClasses` is the last one: a rule that fires "when the payload contains
 * an SSN" would have to run *after* classification, but the gate decides
 * *before* the tool has produced anything to classify. Wiring it would mean
 * re-deciding the verdict at transform time, which is a policy-model change,
 * not a bug fix (noted in the Phase 3 work-log entry).
 *
 * A rule carrying it is skipped entirely: it neither allows nor denies. That is
 * the *permissive* choice, and the console surfaces such rules as "not
 * enforced yet". Phase 5 removed `agents` from this list — posture matchers are
 * evaluated for real now (see {@link agentMatches}).
 */
export const UNEVALUATABLE_MATCHERS = [
  "dataClasses",
] as const satisfies readonly (keyof RuleMatch)[];

/** False when the rule uses a matcher this phase cannot decide. */
export function isEvaluableMatch(match: RuleMatch): boolean {
  return UNEVALUATABLE_MATCHERS.every((key) => match[key] === undefined);
}

/** One posture matcher against one snapshot. */
export function agentMatcherMatches(matcher: AgentMatcher, posture: PostureSnapshot): boolean {
  switch (matcher.kind) {
    case "unknown":
      // "Unknown" means the client could not name an agent at all. An empty
      // string is not an agent id either.
      return posture.agentId === undefined || posture.agentId.trim().length === 0;

    case "agent":
      return posture.agentId === matcher.id;

    case "browser": {
      return postureBrands(posture).some((entry) => {
        if (!sameBrand(entry.brand, matcher.brand)) return false;
        if (matcher.minVersion === undefined && matcher.maxVersion === undefined) return true;

        const major = brandMajorVersion(entry.version);
        // A version range cannot be decided against a version that will not
        // parse. Refusing to match is the same choice made everywhere else in
        // this file: the engine never guesses on behalf of a policy author.
        if (major === null) return false;
        // Both bounds are **inclusive**: `maxVersion: 148` means "148 or older".
        if (matcher.minVersion !== undefined && major < matcher.minVersion) return false;
        if (matcher.maxVersion !== undefined && major > matcher.maxVersion) return false;
        return true;
      });
    }
  }
}

/**
 * The `agents` matcher: a list of alternatives, **ORed** — the rule applies if
 * any one of them describes this caller. (Everything at the `match` level is
 * ANDed; a list inside one matcher has always meant "any of these".)
 *
 * **A rule with an `agents` matcher never fires when no posture was sent.**
 * That is deliberate and it is the permissive direction:
 *
 *  - a client that reports nothing is *not* the same as a client that reports
 *    "no agent" — treating silence as `{kind: "unknown"}` would let one absent
 *    field deny every legacy or non-JS caller;
 *  - the posture pack ships **disabled** for judge safety (`docs/05` §4), so
 *    the honest failure mode of a posture rule has to be "does not fire", not
 *    "fires for everyone";
 *  - posture is advisory anyway (spoofable, `docs/03` threat model). A control
 *    that can be turned off by omitting a field should not be the thing
 *    standing between an agent and patient data — the tool-scoped rules are.
 *
 * An operator who wants "deny anything that does not report posture" writes a
 * deny rule with no matchers and allows the callers they trust ahead of it.
 */
export function agentMatches(matchers: readonly AgentMatcher[], input: PolicyInput): boolean {
  if (input.posture === undefined) return false;
  return matchers.some((matcher) => agentMatcherMatches(matcher, input.posture as PostureSnapshot));
}

/**
 * A rule matches when **every matcher it specifies** matches. An omitted
 * matcher means "don't care", so `match: {}` matches every call.
 */
export function ruleMatches(rule: Rule, input: PolicyInput): boolean {
  const { match } = rule;
  if (!isEvaluableMatch(match)) return false;

  if (match.apps !== undefined && !match.apps.includes(input.app)) return false;

  if (match.agents !== undefined && !agentMatches(match.agents, input)) return false;

  if (match.tools !== undefined) {
    if (Array.isArray(match.tools)) {
      if (!match.tools.includes(input.tool)) return false;
    } else {
      const tags = input.toolTags ?? [];
      if (!match.tools.tags.some((tag) => tags.includes(tag))) return false;
    }
  }

  if (match.roles !== undefined) {
    // No role reported means no role matched: a role-scoped rule must not fire
    // for a session that never claimed the role.
    if (input.role === undefined || !match.roles.includes(input.role)) return false;
  }

  return true;
}

/**
 * Priority ascending; equal priorities keep the order the storage adapter
 * returned them in (`Array.prototype.sort` is stable), which is insertion
 * order. The engine sorts defensively rather than trusting its caller.
 */
export function orderRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.priority - b.priority);
}

/** Resolves both aspects of the policy for one call. */
export function resolvePolicy(policy: PolicyDocument, input: PolicyInput): PolicyDecision {
  const ordered = orderRules(policy.rules).filter((rule) => rule.enabled);

  let gateRule: Rule | null = null;
  let transformRule: Rule | null = null;

  for (const rule of ordered) {
    if (gateRule !== null && transformRule !== null) break;
    if (!ruleMatches(rule, input)) continue;

    if (rule.action.type === "transform") {
      transformRule ??= rule;
    } else if (isGateAction(rule.action)) {
      gateRule ??= rule;
    }
  }

  const verdict: GateVerdict =
    gateRule !== null ? (gateRule.action.type as GateVerdict) : policy.defaultAction;

  const ruleIds = ordered
    .filter((rule) => rule === gateRule || rule === transformRule)
    .map((rule) => rule.id);

  return {
    verdict,
    gateRule,
    transformRule,
    perClass:
      transformRule !== null && transformRule.action.type === "transform"
        ? transformRule.action.perClass
        : null,
    ruleIds,
  };
}
