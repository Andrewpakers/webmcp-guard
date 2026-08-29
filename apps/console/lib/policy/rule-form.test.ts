import { RuleSchema, type Rule } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  addChip,
  allPassthrough,
  emptyRuleForm,
  formToAction,
  formToCreateBody,
  formToMatch,
  formToRule,
  formToUpdateBody,
  isPostureRule,
  moveRule,
  parseChips,
  parseRuleJson,
  removeChip,
  ruleToForm,
  ruleToJson,
} from "./rule-form";

const TRANSFORM_RULE: Rule = RuleSchema.parse({
  id: "tokenize-phi",
  name: "Tokenize PHI in tool results",
  enabled: true,
  priority: 10,
  match: {
    apps: ["lakeside-portal"],
    tools: { tags: ["phi"] },
    roles: ["clinician"],
    dataClasses: ["ssn", "mrn"],
  },
  action: {
    type: "transform",
    perClass: { ssn: "tokenize", mrn: "tokenize", dob: "contextualize", name: "mask" },
  },
});

const DENY_RULE: Rule = RuleSchema.parse({
  id: "deny-delete",
  name: "Agents may not delete patients",
  enabled: false,
  priority: 0,
  match: { tools: ["delete_patient"] },
  action: { type: "deny", message: "Deleting a patient record is not available to agents." },
});

const JUSTIFY_RULE: Rule = RuleSchema.parse({
  id: "justify-export",
  name: "Export requires justification",
  enabled: true,
  priority: 20,
  match: { tools: { tags: ["destructive"] } },
  action: { type: "require-justification", minChars: 40, llmEvaluate: true },
});

const CONFIRM_RULE: Rule = RuleSchema.parse({
  id: "confirm-note",
  name: "Confirm before writing a note",
  enabled: true,
  priority: 30,
  match: { apps: ["lakeside-portal"], agents: [{ kind: "unknown" }] },
  action: { type: "require-confirmation", message: "Approve adding this note to the chart?" },
});

const ALLOW_RULE: Rule = RuleSchema.parse({
  id: "allow-search",
  name: "Search is always available",
  enabled: true,
  priority: 5,
  match: {},
  action: { type: "allow" },
});

describe("rule ⇄ form round trip", () => {
  it.each([
    ["transform", TRANSFORM_RULE],
    ["deny", DENY_RULE],
    ["require-justification", JUSTIFY_RULE],
    ["require-confirmation", CONFIRM_RULE],
    ["allow", ALLOW_RULE],
  ])("survives a %s rule unchanged", (_label, rule) => {
    const result = formToRule(ruleToForm(rule));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule).toEqual(rule);
  });

  it("keeps posture matchers it cannot edit (Phase 5) rather than dropping them", () => {
    const form = ruleToForm(CONFIRM_RULE);
    expect(form.agents).toEqual([{ kind: "unknown" }]);
    expect(formToMatch(form).agents).toEqual([{ kind: "unknown" }]);
  });

  it("distinguishes a tool name list from a tag list", () => {
    expect(ruleToForm(DENY_RULE).toolKind).toBe("names");
    expect(ruleToForm(DENY_RULE).toolNames).toEqual(["delete_patient"]);
    expect(ruleToForm(JUSTIFY_RULE).toolKind).toBe("tags");
    expect(ruleToForm(JUSTIFY_RULE).toolTags).toEqual(["destructive"]);
    expect(ruleToForm(ALLOW_RULE).toolKind).toBe("any");
  });

  it("fills the per-class matrix so every class shows a column selection", () => {
    const form = ruleToForm(TRANSFORM_RULE);
    expect(Object.keys(form.perClass)).toHaveLength(10);
    expect(form.perClass.ssn).toBe("tokenize");
    expect(form.perClass.dob).toBe("contextualize");
    // Classes the author never mentioned default to passthrough.
    expect(form.perClass.credit_card).toBe("passthrough");
  });
});

describe("formToMatch", () => {
  it("omits empty matchers instead of sending arrays that can never match", () => {
    expect(formToMatch(emptyRuleForm())).toEqual({});
  });

  it("only emits the tool matcher the selected kind refers to", () => {
    const form = { ...emptyRuleForm(), toolNames: ["a"], toolTags: ["b"], toolKind: "tags" as const };
    expect(formToMatch(form)).toEqual({ tools: { tags: ["b"] } });
    expect(formToMatch({ ...form, toolKind: "names" })).toEqual({ tools: ["a"] });
    expect(formToMatch({ ...form, toolKind: "any" })).toEqual({});
  });

  it("trims chip whitespace", () => {
    expect(formToMatch({ ...emptyRuleForm(), apps: [" lakeside-portal ", ""] })).toEqual({
      apps: ["lakeside-portal"],
    });
  });
});

describe("formToAction", () => {
  it("omits blank justification fields", () => {
    const form = { ...emptyRuleForm(), actionType: "require-justification" as const };
    expect(formToAction(form)).toEqual({ type: "require-justification" });
    expect(formToAction({ ...form, minChars: "0" })).toEqual({ type: "require-justification" });
    expect(formToAction({ ...form, minChars: "40", llmEvaluate: true })).toEqual({
      type: "require-justification",
      minChars: 40,
      llmEvaluate: true,
    });
  });

  it("copies the matrix rather than aliasing form state", () => {
    const form = { ...emptyRuleForm(), perClass: allPassthrough() };
    const action = formToAction(form);
    form.perClass.ssn = "tokenize";
    expect(action).toEqual({ type: "transform", perClass: allPassthrough() });
  });
});

describe("formToRule validation", () => {
  it("rejects a rule with no name, quoting the schema's own complaint", () => {
    const result = formToRule(emptyRuleForm());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/name/);
  });

  it("rejects a deny rule with no message", () => {
    const result = formToRule({ ...emptyRuleForm(), name: "Block it", actionType: "deny" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/message/);
  });

  it("mints a readable id from the name when the author did not give one", () => {
    const result = formToRule({
      ...emptyRuleForm(),
      name: "Export requires justification",
      actionType: "allow",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.id).toBe("export-requires-justification");
  });
});

describe("create / update bodies", () => {
  it("leaves id and priority to the server on create", () => {
    const body = formToCreateBody({ ...emptyRuleForm(), name: "New rule", actionType: "allow" });
    expect(body).toEqual({
      name: "New rule",
      enabled: true,
      match: {},
      action: { type: "allow" },
    });
    expect("priority" in body).toBe(false);
  });

  it("honours an explicit id", () => {
    const body = formToCreateBody({
      ...emptyRuleForm(),
      id: " my-rule ",
      name: "New rule",
      actionType: "allow",
    });
    expect(body.id).toBe("my-rule");
  });

  it("never sends a priority on update — reordering owns that", () => {
    const body = formToUpdateBody(ruleToForm(TRANSFORM_RULE));
    expect(body).toEqual({
      name: TRANSFORM_RULE.name,
      enabled: true,
      match: TRANSFORM_RULE.match,
      action: TRANSFORM_RULE.action,
    });
    expect("priority" in body).toBe(false);
  });
});

describe("JSON escape hatch", () => {
  it("accepts a rule the shared schema accepts", () => {
    const result = parseRuleJson(ruleToJson(TRANSFORM_RULE));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule).toEqual(TRANSFORM_RULE);
  });

  it("reports a syntax error in plain words", () => {
    const result = parseRuleJson("{ nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Not valid JSON/);
  });

  it("reports schema failures with their field path", () => {
    const result = parseRuleJson(
      JSON.stringify({ id: "x", name: "x", enabled: true, priority: 1, match: {}, action: { type: "nope" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/action/);
  });

  it("rejects unknown keys, so a typo cannot silently do nothing", () => {
    const result = parseRuleJson(
      JSON.stringify({ ...TRANSFORM_RULE, match: { ...TRANSFORM_RULE.match, app: ["typo"] } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("chip helpers", () => {
  it("splits on commas and newlines and drops blanks", () => {
    expect(parseChips(" phi, destructive \n export ,, ")).toEqual(["phi", "destructive", "export"]);
  });

  it("appends without duplicating, and removes", () => {
    expect(addChip(["phi"], "phi, export")).toEqual(["phi", "export"]);
    expect(removeChip(["phi", "export"], "phi")).toEqual(["export"]);
  });
});

describe("moveRule", () => {
  it("swaps a rule with its neighbour", () => {
    expect(moveRule(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveRule(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the ends and for unknown ids", () => {
    expect(moveRule(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveRule(["a", "b"], "b", 1)).toEqual(["a", "b"]);
    expect(moveRule(["a", "b"], "zzz", 1)).toEqual(["a", "b"]);
  });
});

describe("isPostureRule", () => {
  it("matches the Phase 5 posture pack by id or name", () => {
    expect(isPostureRule({ id: "posture-unknown-agent", name: "Unknown agent" })).toBe(true);
    expect(isPostureRule({ id: "r1", name: "Browser posture floor" })).toBe(true);
    expect(isPostureRule({ id: "deny-delete", name: "No deletes" })).toBe(false);
  });
});
