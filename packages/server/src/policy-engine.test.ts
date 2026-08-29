import {
  PerClassTransformSchema,
  PolicyDocumentSchema,
  RuleSchema,
  type PolicyDefaultAction,
  type PolicyDocument,
  type Rule,
  type RuleAction,
  type RuleMatch,
} from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  GATE_ACTION_TYPES,
  UNEVALUATABLE_MATCHERS,
  isEvaluableMatch,
  orderRules,
  resolvePolicy,
  ruleMatches,
  type PolicyInput,
} from "./policy-engine";

const APP = "lakeside-portal";

const TRANSFORM_ACTION: RuleAction = {
  type: "transform",
  perClass: PerClassTransformSchema.parse({ ssn: "tokenize" }),
};

let idCounter = 0;

function rule(overrides: Partial<Rule> = {}): Rule {
  idCounter += 1;
  return RuleSchema.parse({
    id: `rule-${idCounter}`,
    name: `Rule ${idCounter}`,
    enabled: true,
    priority: 10,
    match: {},
    action: { type: "allow" },
    ...overrides,
  });
}

function policy(rules: Rule[], defaultAction: PolicyDefaultAction = "allow"): PolicyDocument {
  return PolicyDocumentSchema.parse({ version: 1, defaultAction, rules });
}

const call: PolicyInput = { app: APP, tool: "search_patients", toolTags: ["read", "phi"] };

describe("ruleMatches", () => {
  it("matches everything when the rule specifies no matchers", () => {
    expect(ruleMatches(rule({ match: {} }), call)).toBe(true);
  });

  it("matches on app", () => {
    expect(ruleMatches(rule({ match: { apps: [APP] } }), call)).toBe(true);
    expect(ruleMatches(rule({ match: { apps: ["other-app", APP] } }), call)).toBe(true);
    expect(ruleMatches(rule({ match: { apps: ["other-app"] } }), call)).toBe(false);
  });

  it("matches on tool name", () => {
    expect(ruleMatches(rule({ match: { tools: ["search_patients"] } }), call)).toBe(true);
    expect(ruleMatches(rule({ match: { tools: ["get_patient", "search_patients"] } }), call)).toBe(
      true,
    );
    expect(ruleMatches(rule({ match: { tools: ["delete_patient"] } }), call)).toBe(false);
  });

  it("matches when any tag intersects the tool's tags", () => {
    expect(ruleMatches(rule({ match: { tools: { tags: ["phi"] } } }), call)).toBe(true);
    expect(ruleMatches(rule({ match: { tools: { tags: ["destructive", "phi"] } } }), call)).toBe(
      true,
    );
    expect(ruleMatches(rule({ match: { tools: { tags: ["destructive"] } } }), call)).toBe(false);
  });

  it("does not match a tag rule when the call reported no tags", () => {
    const untagged: PolicyInput = { app: APP, tool: "search_patients" };
    expect(ruleMatches(rule({ match: { tools: { tags: ["phi"] } } }), untagged)).toBe(false);
  });

  it("matches on role, and never matches a call with no role", () => {
    const withRole: PolicyInput = { ...call, role: "billing" };
    expect(ruleMatches(rule({ match: { roles: ["billing"] } }), withRole)).toBe(true);
    expect(ruleMatches(rule({ match: { roles: ["clinician"] } }), withRole)).toBe(false);
    expect(ruleMatches(rule({ match: { roles: ["billing"] } }), call)).toBe(false);
  });

  it("ANDs every matcher the rule specifies", () => {
    const match = { apps: [APP], tools: { tags: ["phi"] }, roles: ["billing"] };
    expect(ruleMatches(rule({ match }), { ...call, role: "billing" })).toBe(true);
    expect(ruleMatches(rule({ match }), { ...call, role: "clinician" })).toBe(false);
    expect(ruleMatches(rule({ match }), { ...call, app: "other-app", role: "billing" })).toBe(
      false,
    );
    expect(ruleMatches(rule({ match }), { ...call, toolTags: ["read"], role: "billing" })).toBe(
      false,
    );
  });

  describe("matchers this phase cannot evaluate", () => {
    it("lists agents and dataClasses", () => {
      expect(UNEVALUATABLE_MATCHERS).toEqual(["agents", "dataClasses"]);
      expect(isEvaluableMatch({})).toBe(true);
      expect(isEvaluableMatch({ apps: [APP] })).toBe(true);
      expect(isEvaluableMatch({ agents: [{ kind: "unknown" }] })).toBe(false);
      expect(isEvaluableMatch({ dataClasses: ["ssn"] })).toBe(false);
    });

    it("never matches a posture rule, even when everything else lines up", () => {
      const posture = rule({
        match: { apps: [APP], tools: ["search_patients"], agents: [{ kind: "unknown" }] },
        action: { type: "deny", message: "Unknown agent" },
      });
      expect(ruleMatches(posture, call)).toBe(false);
    });

    it("never matches a data-class rule yet", () => {
      const byClass = rule({
        match: { tools: { tags: ["phi"] }, dataClasses: ["ssn"] },
        action: { type: "deny", message: "SSN present" },
      });
      expect(ruleMatches(byClass, call)).toBe(false);
    });

    it("lets the next rule decide instead", () => {
      const document = policy([
        rule({
          id: "posture",
          priority: 10,
          match: { agents: [{ kind: "unknown" }] },
          action: { type: "deny", message: "Unknown agent" },
        }),
        rule({ id: "fallback", priority: 20, action: { type: "allow" } }),
      ]);

      const decision = resolvePolicy(document, call);
      expect(decision.verdict).toBe("allow");
      expect(decision.ruleIds).toEqual(["fallback"]);
    });
  });
});

describe("orderRules", () => {
  it("sorts by priority ascending and keeps insertion order for ties", () => {
    const a = rule({ id: "a", priority: 20 });
    const b = rule({ id: "b", priority: 10 });
    const c = rule({ id: "c", priority: 10 });
    const d = rule({ id: "d", priority: -5 });

    expect(orderRules([a, b, c, d]).map((entry) => entry.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const rules = [rule({ id: "a", priority: 20 }), rule({ id: "b", priority: 10 })];
    orderRules(rules);
    expect(rules.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("resolvePolicy — gate aspect", () => {
  it("falls back to the document default when nothing matches", () => {
    expect(resolvePolicy(policy([]), call)).toMatchObject({
      verdict: "allow",
      gateRule: null,
      transformRule: null,
      perClass: null,
      ruleIds: [],
    });

    expect(resolvePolicy(policy([], "deny"), call).verdict).toBe("deny");
  });

  it("falls back to the default when every matching rule is disabled", () => {
    const document = policy([
      rule({ id: "off", enabled: false, action: { type: "deny", message: "no" } }),
    ]);

    const decision = resolvePolicy(document, call);
    expect(decision.verdict).toBe("allow");
    expect(decision.ruleIds).toEqual([]);
  });

  it.each(GATE_ACTION_TYPES)("returns the %s verdict of the first matching rule", (type) => {
    const action = (
      type === "deny"
        ? { type, message: "Denied for a reason" }
        : type === "require-confirmation"
          ? { type, message: "A human must approve" }
          : type === "require-justification"
            ? { type, minChars: 40 }
            : { type }
    ) as RuleAction;

    const document = policy([
      rule({ id: "decider", match: { tools: ["search_patients"] }, action }),
    ]);
    const decision = resolvePolicy(document, call);

    expect(decision.verdict).toBe(type);
    expect(decision.gateRule?.id).toBe("decider");
    expect(decision.ruleIds).toEqual(["decider"]);
  });

  const matcherCases: [label: string, match: RuleMatch][] = [
    ["app", { apps: [APP] }],
    ["tool name", { tools: ["search_patients"] }],
    ["tag intersection", { tools: { tags: ["phi"] } }],
    ["role", { roles: ["billing"] }],
    ["everything", {}],
  ];

  it.each(matcherCases)("denies through the %s matcher", (_label, match) => {
    const document = policy([
      rule({ id: "denier", match, action: { type: "deny", message: "Blocked" } }),
    ]);

    const decision = resolvePolicy(document, { ...call, role: "billing" });
    expect(decision.verdict).toBe("deny");
    expect(decision.gateRule?.id).toBe("denier");
  });

  it("lets the lowest-priority matching rule win, not document order", () => {
    const document = policy([
      rule({ id: "late-allow", priority: 50, action: { type: "allow" } }),
      rule({ id: "early-deny", priority: 5, action: { type: "deny", message: "Blocked" } }),
    ]);

    const decision = resolvePolicy(document, call);
    expect(decision.verdict).toBe("deny");
    expect(decision.ruleIds).toEqual(["early-deny"]);
  });

  it("breaks priority ties by insertion order", () => {
    const document = policy([
      rule({ id: "first", priority: 10, action: { type: "allow" } }),
      rule({ id: "second", priority: 10, action: { type: "deny", message: "Blocked" } }),
    ]);

    expect(resolvePolicy(document, call).verdict).toBe("allow");

    const flipped = policy([
      rule({ id: "second", priority: 10, action: { type: "deny", message: "Blocked" } }),
      rule({ id: "first", priority: 10, action: { type: "allow" } }),
    ]);

    expect(resolvePolicy(flipped, call).verdict).toBe("deny");
  });

  it("ignores later matching gate rules once one has decided", () => {
    const document = policy([
      rule({ id: "winner", priority: 10, action: { type: "allow" } }),
      rule({ id: "loser", priority: 20, action: { type: "deny", message: "Blocked" } }),
    ]);

    expect(resolvePolicy(document, call).ruleIds).toEqual(["winner"]);
  });
});

describe("resolvePolicy — transform aspect", () => {
  it("returns the per-class matrix of the first matching transform rule", () => {
    const document = policy([
      rule({
        id: "phi",
        priority: 10,
        match: { tools: { tags: ["phi"] } },
        action: TRANSFORM_ACTION,
      }),
      rule({
        id: "later-transform",
        priority: 20,
        action: {
          type: "transform",
          perClass: PerClassTransformSchema.parse({ ssn: "mask" }),
        },
      }),
    ]);

    const decision = resolvePolicy(document, call);
    expect(decision.transformRule?.id).toBe("phi");
    expect(decision.perClass?.ssn).toBe("tokenize");
    expect(decision.perClass?.phone).toBe("passthrough");
  });

  it("does not affect the verdict, which stays on the baseline", () => {
    const document = policy([rule({ id: "phi", action: TRANSFORM_ACTION })]);

    const decision = resolvePolicy(document, call);
    expect(decision.verdict).toBe("allow");
    expect(decision.gateRule).toBeNull();
    expect(decision.ruleIds).toEqual(["phi"]);
  });

  it("skips a disabled transform rule", () => {
    const document = policy([rule({ id: "phi", enabled: false, action: TRANSFORM_ACTION })]);

    expect(resolvePolicy(document, call).perClass).toBeNull();
  });
});

describe("resolvePolicy — both aspects together", () => {
  it("resolves the two aspects from different rules and reports both ids in order", () => {
    const document = policy([
      rule({
        id: "phi-transform-default",
        priority: 10,
        match: { tools: { tags: ["phi"] } },
        action: TRANSFORM_ACTION,
      }),
      rule({
        id: "delete-patient-deny-temp",
        priority: 40,
        match: { tools: ["delete_patient"] },
        action: { type: "deny", message: "Not from an agent" },
      }),
    ]);

    const decision = resolvePolicy(document, {
      app: APP,
      tool: "delete_patient",
      toolTags: ["write", "destructive", "phi"],
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.gateRule?.id).toBe("delete-patient-deny-temp");
    expect(decision.transformRule?.id).toBe("phi-transform-default");
    expect(decision.ruleIds).toEqual(["phi-transform-default", "delete-patient-deny-temp"]);
  });

  it("reports rule ids in document order, not aspect order", () => {
    const document = policy([
      rule({ id: "gate-first", priority: 10, action: { type: "deny", message: "Blocked" } }),
      rule({ id: "transform-second", priority: 20, action: TRANSFORM_ACTION }),
    ]);

    expect(resolvePolicy(document, call).ruleIds).toEqual(["gate-first", "transform-second"]);
  });

  it("reports a single id when one rule is the only match", () => {
    const document = policy([rule({ id: "only", action: { type: "deny", message: "Blocked" } })]);
    expect(resolvePolicy(document, call).ruleIds).toEqual(["only"]);
  });
});
