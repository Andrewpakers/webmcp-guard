import { PerClassTransformSchema, type RuleAction } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { ACTION_BADGE, summarizeAction, summarizeMatch, transformSummary } from "./summary";

describe("summarizeMatch", () => {
  it("describes an unconstrained rule honestly", () => {
    expect(summarizeMatch({})).toEqual([{ label: "matches", value: "every tool call" }]);
  });

  it("labels a name list and a tag list differently", () => {
    expect(summarizeMatch({ tools: ["delete_patient"] })).toEqual([
      { label: "tools", value: "delete_patient" },
    ]);
    expect(summarizeMatch({ tools: { tags: ["phi", "destructive"] } })).toEqual([
      { label: "tags", value: "phi, destructive" },
    ]);
  });

  it("counts posture matchers rather than dumping their JSON", () => {
    expect(summarizeMatch({ agents: [{ kind: "unknown" }] })).toEqual([
      { label: "agents", value: "1 posture matcher" },
    ]);
    expect(
      summarizeMatch({ agents: [{ kind: "unknown" }, { kind: "agent", id: "atlas" }] })[0].value,
    ).toBe("2 posture matchers");
  });

  it("lists every facet a rule constrains", () => {
    const facets = summarizeMatch({
      apps: ["lakeside-portal"],
      tools: ["get_patient"],
      roles: ["billing"],
      dataClasses: ["ssn"],
    });
    expect(facets.map((facet) => facet.label)).toEqual(["apps", "tools", "roles", "classes"]);
  });
});

describe("transformSummary", () => {
  it("reports only the cells that change something", () => {
    const perClass = PerClassTransformSchema.parse({ ssn: "tokenize", dob: "contextualize" });
    expect(transformSummary(perClass)).toEqual([
      { dataClass: "ssn", action: "tokenize" },
      { dataClass: "dob", action: "contextualize" },
    ]);
  });

  it("is empty for an all-passthrough matrix", () => {
    expect(transformSummary(PerClassTransformSchema.parse({}))).toEqual([]);
  });
});

describe("summarizeAction", () => {
  it("quotes the agent-facing message for deny and confirmation", () => {
    expect(summarizeAction({ type: "deny", message: "Not available to agents." })).toBe(
      "Not available to agents.",
    );
  });

  it("describes justification requirements", () => {
    expect(summarizeAction({ type: "require-justification" })).toBe("justification required");
    expect(
      summarizeAction({ type: "require-justification", minChars: 40, llmEvaluate: true }),
    ).toBe("justification — min 40 chars, evaluated");
  });

  it("renders the transform matrix as class→action pairs", () => {
    const action: RuleAction = {
      type: "transform",
      perClass: PerClassTransformSchema.parse({ ssn: "tokenize", name: "mask" }),
    };
    expect(summarizeAction(action)).toBe("ssn→tokenize, name→mask");
  });

  it("calls out a transform rule that does nothing", () => {
    const action: RuleAction = { type: "transform", perClass: PerClassTransformSchema.parse({}) };
    expect(summarizeAction(action)).toContain("all passthrough");
  });

  it("has a badge for every action type", () => {
    for (const type of [
      "allow",
      "deny",
      "require-confirmation",
      "require-justification",
      "transform",
    ] as const) {
      expect(ACTION_BADGE[type]).toBeTruthy();
    }
  });
});
