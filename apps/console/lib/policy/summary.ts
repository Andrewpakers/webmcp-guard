import type { DataClass, Rule, RuleAction, TransformAction } from "@webmcp-guard/shared";

/**
 * One-line summaries of a rule for the policy list, so an operator can read the
 * whole policy without opening every editor.
 */

export interface MatchFacet {
  label: string;
  value: string;
}

export function summarizeMatch(match: Rule["match"]): MatchFacet[] {
  const facets: MatchFacet[] = [];

  if (match.apps !== undefined) facets.push({ label: "apps", value: match.apps.join(", ") });

  if (Array.isArray(match.tools)) {
    facets.push({ label: "tools", value: match.tools.join(", ") });
  } else if (match.tools !== undefined) {
    facets.push({ label: "tags", value: match.tools.tags.join(", ") });
  }

  if (match.roles !== undefined) facets.push({ label: "roles", value: match.roles.join(", ") });

  if (match.dataClasses !== undefined) {
    facets.push({ label: "classes", value: match.dataClasses.join(", ") });
  }

  if (match.agents !== undefined) {
    facets.push({
      label: "agents",
      value: `${match.agents.length} posture matcher${match.agents.length === 1 ? "" : "s"}`,
    });
  }

  if (facets.length === 0) facets.push({ label: "matches", value: "every tool call" });
  return facets;
}

/** Non-passthrough cells of the matrix — what the rule actually changes. */
export function transformSummary(
  perClass: Record<DataClass, TransformAction>,
): Array<{ dataClass: DataClass; action: TransformAction }> {
  return Object.entries(perClass)
    .filter(([, action]) => action !== "passthrough")
    .map(([dataClass, action]) => ({
      dataClass: dataClass as DataClass,
      action: action as TransformAction,
    }));
}

export function summarizeAction(action: RuleAction): string {
  switch (action.type) {
    case "allow":
      return "allow and log";
    case "deny":
      return action.message;
    case "require-confirmation":
      return action.message;
    case "require-justification": {
      const parts: string[] = [];
      if (action.minChars !== undefined) parts.push(`min ${action.minChars} chars`);
      if (action.llmEvaluate === true) parts.push("evaluated");
      return parts.length === 0 ? "justification required" : `justification — ${parts.join(", ")}`;
    }
    case "transform": {
      const changed = transformSummary(action.perClass);
      if (changed.length === 0) return "transform — nothing changed (all passthrough)";
      return changed.map((cell) => `${cell.dataClass}→${cell.action}`).join(", ");
    }
    default:
      return "";
  }
}

/** Tailwind classes for the action badge on a rule row. */
export const ACTION_BADGE: Record<RuleAction["type"], string> = {
  allow: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  deny: "border-red-500/30 bg-red-500/10 text-red-300",
  "require-confirmation": "border-amber-500/30 bg-amber-500/10 text-amber-300",
  "require-justification": "border-amber-500/30 bg-amber-500/10 text-amber-300",
  transform: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
};
