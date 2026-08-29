import type {
  GateVerdict,
  PerClassTransform,
  PolicyDocument,
  Rule,
  RuleAction,
  RuleMatch,
} from "@webmcp-guard/shared";

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

/** What the engine knows about a call. Posture and payload classes are not here yet. */
export interface PolicyInput {
  app: string;
  tool: string;
  /** Tags the page attached at registration, e.g. `["read", "phi"]`. */
  toolTags?: string[];
  /** Session role from the host app (`docs/07` Phase 6). */
  role?: string;
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
 * Matchers this phase cannot evaluate, and therefore refuses to pretend it can.
 *
 * - `agents` needs the posture snapshot and the browser-version comparison that
 *   Phase 5 adds;
 * - `dataClasses` needs the classifier that Phase 3 adds — a rule that fires
 *   "when the payload contains an SSN" cannot be decided before anything has
 *   been classified.
 *
 * A rule carrying either matcher is skipped entirely: it neither allows nor
 * denies. That is the *permissive* choice, and it is only safe because the
 * seeded posture rule ships disabled (`docs/05` §4, judge safety) — a deny rule
 * that silently never fires would otherwise be worse than no rule at all. The
 * console must surface such rules as "not enforced yet"; see the report in the
 * work log. Phases 3 and 5 delete entries from this list as they teach the
 * engine to evaluate them.
 */
export const UNEVALUATABLE_MATCHERS = [
  "agents",
  "dataClasses",
] as const satisfies readonly (keyof RuleMatch)[];

/** False when the rule uses a matcher this phase cannot decide. */
export function isEvaluableMatch(match: RuleMatch): boolean {
  return UNEVALUATABLE_MATCHERS.every((key) => match[key] === undefined);
}

/**
 * A rule matches when **every matcher it specifies** matches. An omitted
 * matcher means "don't care", so `match: {}` matches every call.
 */
export function ruleMatches(rule: Rule, input: PolicyInput): boolean {
  const { match } = rule;
  if (!isEvaluableMatch(match)) return false;

  if (match.apps !== undefined && !match.apps.includes(input.app)) return false;

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
