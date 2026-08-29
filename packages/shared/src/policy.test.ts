import { describe, expect, it } from "vitest";

import { DATA_CLASSES } from "./data-class";
import {
  AgentMatcherSchema,
  PerClassTransformSchema,
  PolicyDocumentSchema,
  RuleActionSchema,
  RuleMatchSchema,
  RuleSchema,
  ToolMatcherSchema,
  type RuleInput,
} from "./policy";

const validRule: RuleInput = {
  id: "P-7",
  name: "Destructive tools require justification",
  enabled: true,
  priority: 10,
  match: { apps: ["lakeside-portal"], tools: { tags: ["destructive"] } },
  action: { type: "require-justification", minChars: 40 },
};

describe("ToolMatcherSchema", () => {
  it("accepts an explicit tool-name list", () => {
    expect(ToolMatcherSchema.parse(["delete_patient", "export_patients"])).toEqual([
      "delete_patient",
      "export_patients",
    ]);
  });

  it("accepts a tag matcher", () => {
    expect(ToolMatcherSchema.parse({ tags: ["destructive"] })).toEqual({ tags: ["destructive"] });
  });

  it("rejects an empty tag set", () => {
    expect(ToolMatcherSchema.safeParse({ tags: [] }).success).toBe(false);
  });

  it("rejects an empty tool-name list (would round-trip to match-everything)", () => {
    expect(ToolMatcherSchema.safeParse([]).success).toBe(false);
  });

  it("rejects unknown keys in the tag matcher", () => {
    expect(ToolMatcherSchema.safeParse({ tags: ["a"], names: ["b"] }).success).toBe(false);
  });
});

describe("AgentMatcherSchema", () => {
  it("accepts the three matcher kinds", () => {
    expect(AgentMatcherSchema.parse({ kind: "unknown" })).toEqual({ kind: "unknown" });
    expect(AgentMatcherSchema.parse({ kind: "agent", id: "chatgpt-atlas" })).toEqual({
      kind: "agent",
      id: "chatgpt-atlas",
    });
    expect(
      AgentMatcherSchema.parse({ kind: "browser", brand: "Chromium", minVersion: 149 }),
    ).toEqual({ kind: "browser", brand: "Chromium", minVersion: 149 });
  });

  it("rejects an unrecognised kind", () => {
    expect(AgentMatcherSchema.safeParse({ kind: "robot" }).success).toBe(false);
  });

  it("rejects a non-integer browser version", () => {
    expect(
      AgentMatcherSchema.safeParse({ kind: "browser", brand: "Chromium", minVersion: 14.9 })
        .success,
    ).toBe(false);
  });
});

describe("RuleMatchSchema", () => {
  it("accepts an empty match (matches everything)", () => {
    expect(RuleMatchSchema.parse({})).toEqual({});
  });

  it("accepts every matcher together", () => {
    const match = {
      apps: ["lakeside-portal"],
      tools: ["get_patient"],
      agents: [{ kind: "unknown" as const }],
      roles: ["billing"],
      dataClasses: ["ssn" as const],
    };
    expect(RuleMatchSchema.parse(match)).toEqual(match);
  });

  it("rejects unknown matchers so typos fail loudly", () => {
    expect(RuleMatchSchema.safeParse({ apps: ["a"], tolls: ["b"] }).success).toBe(false);
  });

  it("rejects an unknown data class", () => {
    expect(RuleMatchSchema.safeParse({ dataClasses: ["passport"] }).success).toBe(false);
  });
});

describe("PerClassTransformSchema", () => {
  it("covers exactly the DataClass enum", () => {
    expect(Object.keys(PerClassTransformSchema.shape)).toEqual([...DATA_CLASSES]);
  });

  it("defaults every unspecified class to passthrough", () => {
    const parsed = PerClassTransformSchema.parse({ ssn: "tokenize", dob: "contextualize" });

    expect(parsed.ssn).toBe("tokenize");
    expect(parsed.dob).toBe("contextualize");
    expect(parsed.email).toBe("passthrough");
    expect(Object.keys(parsed)).toHaveLength(DATA_CLASSES.length);
  });

  it("rejects an unknown transform action", () => {
    expect(PerClassTransformSchema.safeParse({ ssn: "shred" }).success).toBe(false);
  });

  it("rejects an unknown data class", () => {
    expect(PerClassTransformSchema.safeParse({ passport: "tokenize" }).success).toBe(false);
  });
});

describe("RuleActionSchema", () => {
  it("accepts each action variant", () => {
    expect(RuleActionSchema.parse({ type: "allow" })).toEqual({ type: "allow" });
    expect(RuleActionSchema.parse({ type: "deny", message: "no" })).toEqual({
      type: "deny",
      message: "no",
    });
    expect(RuleActionSchema.parse({ type: "require-confirmation", message: "sure?" }).type).toBe(
      "require-confirmation",
    );
    expect(RuleActionSchema.parse({ type: "require-justification" }).type).toBe(
      "require-justification",
    );

    const transform = RuleActionSchema.parse({ type: "transform", perClass: { ssn: "mask" } });
    expect(transform).toMatchObject({ type: "transform", perClass: { ssn: "mask" } });
  });

  it("requires a message on deny", () => {
    expect(RuleActionSchema.safeParse({ type: "deny" }).success).toBe(false);
    expect(RuleActionSchema.safeParse({ type: "deny", message: "" }).success).toBe(false);
  });

  it("rejects an unknown action type", () => {
    expect(RuleActionSchema.safeParse({ type: "quarantine" }).success).toBe(false);
  });

  it("rejects fields from a sibling variant", () => {
    expect(RuleActionSchema.safeParse({ type: "allow", message: "why is this here" }).success).toBe(
      false,
    );
  });

  it("rejects a non-positive minChars", () => {
    expect(RuleActionSchema.safeParse({ type: "require-justification", minChars: 0 }).success).toBe(
      false,
    );
  });
});

describe("RuleSchema", () => {
  it("accepts a well-formed rule", () => {
    const parsed = RuleSchema.parse(validRule);
    expect(parsed.id).toBe("P-7");
    expect(parsed.action).toEqual({ type: "require-justification", minChars: 40 });
  });

  it("rejects a rule missing required fields", () => {
    const { priority: _priority, ...withoutPriority } = validRule;
    expect(RuleSchema.safeParse(withoutPriority).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(RuleSchema.safeParse({ ...validRule, name: "" }).success).toBe(false);
  });

  it("rejects a non-integer priority", () => {
    expect(RuleSchema.safeParse({ ...validRule, priority: 1.5 }).success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(RuleSchema.safeParse({ ...validRule, comment: "hi" }).success).toBe(false);
  });
});

describe("PolicyDocumentSchema", () => {
  it("defaults to an allow baseline", () => {
    const parsed = PolicyDocumentSchema.parse({ version: 1, rules: [validRule] });
    expect(parsed.defaultAction).toBe("allow");
    expect(parsed.rules).toHaveLength(1);
  });

  it("accepts an explicit deny baseline", () => {
    const parsed = PolicyDocumentSchema.parse({ version: 1, defaultAction: "deny", rules: [] });
    expect(parsed.defaultAction).toBe("deny");
  });

  it("rejects an unsupported document version", () => {
    expect(PolicyDocumentSchema.safeParse({ version: 2, rules: [] }).success).toBe(false);
  });

  it("rejects a document containing an invalid rule", () => {
    const result = PolicyDocumentSchema.safeParse({
      version: 1,
      rules: [{ ...validRule, action: { type: "deny" } }],
    });
    expect(result.success).toBe(false);
  });
});
