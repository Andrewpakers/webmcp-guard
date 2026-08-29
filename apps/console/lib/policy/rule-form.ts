import {
  DATA_CLASSES,
  RuleSchema,
  slugifyRuleId,
  type AgentMatcher,
  type DataClass,
  type PerClassTransform,
  type Rule,
  type RuleAction,
  type RuleActionType,
  type RuleMatch,
  type TransformAction,
} from "@webmcp-guard/shared";

import type { RuleCreateBody, RuleUpdateBody } from "@/lib/api/guard-client";

/**
 * The structured rule builder (`docs/06-console-requirements.md` §2) as pure
 * state plus two total functions: `ruleToForm` and `formToRule`. The React form
 * is a thin editor over `RuleFormState`; every conversion, default and
 * validation decision lives here where it is testable, and the shared
 * `RuleSchema` — not the console — has the last word on what is valid.
 */

/** How the WHEN section is expressing "which tools" (docs/04 `ToolMatcher`). */
export type ToolMatcherKind = "any" | "names" | "tags";

export interface RuleFormState {
  /** Blank on a new rule: the server mints one from the name. */
  id: string;
  name: string;
  enabled: boolean;
  /** `null` on a new rule — the storage adapter appends it to the end. */
  priority: number | null;
  // WHEN
  apps: string[];
  toolKind: ToolMatcherKind;
  toolNames: string[];
  toolTags: string[];
  roles: string[];
  dataClasses: DataClass[];
  /**
   * Posture matchers are round-tripped untouched and shown read-only: the
   * policy engine treats them as inert until Phase 5, so an editor for them
   * would promise enforcement that does not exist yet.
   */
  agents: AgentMatcher[] | null;
  // THEN
  actionType: RuleActionType;
  denyMessage: string;
  confirmationMessage: string;
  /** Free text so the input can be empty; parsed on submit. */
  minChars: string;
  llmEvaluate: boolean;
  perClass: PerClassTransform;
}

export const ACTION_TYPES = [
  "allow",
  "deny",
  "require-confirmation",
  "require-justification",
  "transform",
] as const satisfies readonly RuleActionType[];

export const ACTION_LABEL: Record<RuleActionType, string> = {
  allow: "Allow",
  deny: "Deny",
  "require-confirmation": "Require confirmation",
  "require-justification": "Require justification",
  transform: "Transform data",
};

export const ACTION_HINT: Record<RuleActionType, string> = {
  allow: "Let the call through and log it. Use to carve an exception out of a broader rule.",
  deny: "Refuse the call. The agent gets your message instead of a result.",
  "require-confirmation":
    "The human approves in-page before the tool runs. One-time id, no replay.",
  "require-justification": "The agent must state why. Optionally evaluated before the call runs.",
  transform: "Let the call run, then rewrite the result per data class before the agent sees it.",
};

export function allPassthrough(): PerClassTransform {
  return Object.fromEntries(
    DATA_CLASSES.map((dataClass) => [dataClass, "passthrough" as TransformAction]),
  ) as PerClassTransform;
}

export function emptyRuleForm(): RuleFormState {
  return {
    id: "",
    name: "",
    enabled: true,
    priority: null,
    apps: [],
    toolKind: "any",
    toolNames: [],
    toolTags: [],
    roles: [],
    dataClasses: [],
    agents: null,
    actionType: "transform",
    denyMessage: "",
    confirmationMessage: "",
    minChars: "",
    llmEvaluate: false,
    perClass: allPassthrough(),
  };
}

export function ruleToForm(rule: Rule): RuleFormState {
  const form = emptyRuleForm();
  form.id = rule.id;
  form.name = rule.name;
  form.enabled = rule.enabled;
  form.priority = rule.priority;

  form.apps = rule.match.apps ?? [];
  form.roles = rule.match.roles ?? [];
  form.dataClasses = rule.match.dataClasses ?? [];
  form.agents = rule.match.agents ?? null;

  const tools = rule.match.tools;
  if (Array.isArray(tools)) {
    form.toolKind = "names";
    form.toolNames = [...tools];
  } else if (tools !== undefined) {
    form.toolKind = "tags";
    form.toolTags = [...tools.tags];
  }

  form.actionType = rule.action.type;
  switch (rule.action.type) {
    case "deny":
      form.denyMessage = rule.action.message;
      break;
    case "require-confirmation":
      form.confirmationMessage = rule.action.message;
      break;
    case "require-justification":
      form.minChars = rule.action.minChars === undefined ? "" : String(rule.action.minChars);
      form.llmEvaluate = rule.action.llmEvaluate ?? false;
      break;
    case "transform":
      form.perClass = { ...rule.action.perClass };
      break;
    case "allow":
    default:
      break;
  }

  return form;
}

/**
 * Builds the WHEN half. An empty control means "don't care" and is omitted
 * entirely rather than sent as `[]`, which the schema would read as a matcher
 * that can never match.
 */
export function formToMatch(form: RuleFormState): RuleMatch {
  const apps = trimList(form.apps);
  const roles = trimList(form.roles);
  const toolNames = trimList(form.toolNames);
  const toolTags = trimList(form.toolTags);

  return {
    ...(apps.length > 0 ? { apps } : {}),
    ...(form.toolKind === "names" && toolNames.length > 0 ? { tools: toolNames } : {}),
    ...(form.toolKind === "tags" && toolTags.length > 0 ? { tools: { tags: toolTags } } : {}),
    ...(form.agents !== null && form.agents.length > 0 ? { agents: form.agents } : {}),
    ...(roles.length > 0 ? { roles } : {}),
    ...(form.dataClasses.length > 0 ? { dataClasses: [...form.dataClasses] } : {}),
  };
}

/** Builds the THEN half. Per-action fields that are blank are left out. */
export function formToAction(form: RuleFormState): RuleAction {
  switch (form.actionType) {
    case "deny":
      return { type: "deny", message: form.denyMessage.trim() };
    case "require-confirmation":
      return { type: "require-confirmation", message: form.confirmationMessage.trim() };
    case "require-justification": {
      const parsed = Number.parseInt(form.minChars.trim(), 10);
      return {
        type: "require-justification",
        ...(Number.isSafeInteger(parsed) && parsed > 0 ? { minChars: parsed } : {}),
        ...(form.llmEvaluate ? { llmEvaluate: true } : {}),
      };
    }
    case "transform":
      return { type: "transform", perClass: { ...form.perClass } };
    case "allow":
    default:
      return { type: "allow" };
  }
}

export type RuleFormResult = { ok: true; rule: Rule } | { ok: false; errors: string[] };

/**
 * Validates the whole builder against the shared schema. `priorityFallback` is
 * only used to satisfy the schema for a rule the server has not numbered yet —
 * creation never sends a priority, and re-ordering is a separate endpoint.
 */
export function formToRule(form: RuleFormState, priorityFallback = 0): RuleFormResult {
  const name = form.name.trim();
  const id = form.id.trim().length > 0 ? form.id.trim() : slugifyRuleId(name);

  const candidate = {
    id,
    name,
    enabled: form.enabled,
    priority: form.priority ?? priorityFallback,
    match: formToMatch(form),
    action: formToAction(form),
  };

  const parsed = RuleSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error.issues) };
  return { ok: true, rule: parsed.data };
}

/** `POST /policies` body: no priority (append), no id unless one was typed. */
export function formToCreateBody(form: RuleFormState): RuleCreateBody {
  const validated = formToRule(form);
  const rule = validated.ok ? validated.rule : null;
  const name = form.name.trim();
  const explicitId = form.id.trim();

  return {
    ...(explicitId.length > 0 ? { id: explicitId } : {}),
    name,
    enabled: form.enabled,
    match: rule?.match ?? formToMatch(form),
    action: rule?.action ?? formToAction(form),
  };
}

/** `PUT /policies/:id` body. Priority is owned by the reorder endpoint. */
export function formToUpdateBody(form: RuleFormState): RuleUpdateBody {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    match: formToMatch(form),
    action: formToAction(form),
  };
}

/** The JSON escape hatch: raw text → a validated `Rule`, or readable errors. */
export function parseRuleJson(text: string): RuleFormResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`Not valid JSON — ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const parsed = RuleSchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: describeIssues(parsed.error.issues) };
  return { ok: true, rule: parsed.data };
}

export function ruleToJson(rule: Rule): string {
  return JSON.stringify(rule, null, 2);
}

/** Chip input: `"phi, destructive"` (or newline-separated) → `["phi","destructive"]`. */
export function parseChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((chip) => chip.trim())
    .filter((chip) => chip.length > 0);
}

export function addChip(list: string[], text: string): string[] {
  const next = [...list];
  for (const chip of parseChips(text)) {
    if (!next.includes(chip)) next.push(chip);
  }
  return next;
}

export function removeChip(list: string[], chip: string): string[] {
  return list.filter((item) => item !== chip);
}

/** Ordered ids after moving `id` one slot up or down — the reorder payload. */
export function moveRule(ids: string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  const target = index + direction;
  if (target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** True when the rule looks like part of the Phase 5 posture pack. */
export function isPostureRule(rule: Pick<Rule, "id" | "name">): boolean {
  const haystack = `${rule.id} ${rule.name}`.toLowerCase();
  return haystack.includes("posture");
}

function trimList(list: string[]): string[] {
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}

interface IssueLike {
  path: PropertyKey[];
  message: string;
}

function describeIssues(issues: readonly IssueLike[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}
