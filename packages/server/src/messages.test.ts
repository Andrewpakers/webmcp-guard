import { RuleSchema, type Rule, type TransformAction } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { transformNotice } from "./messages";

/**
 * The agent-facing privacy notice. It is prose a model acts on, so the tests
 * here are about what it *claims*: it must never explain a mechanism this
 * result did not use, and it must not appear at all on a result the guard left
 * alone (`docs/05`: the guard is not redaction-happy).
 */

const RULE: Rule = RuleSchema.parse({
  id: "phi-transform-default",
  name: "Tokenize PHI on phi-tagged tools",
  enabled: true,
  priority: 10,
  match: { tools: { tags: ["phi"] } },
  action: { type: "transform", perClass: { name: "tokenize" } },
});

describe("transformNotice", () => {
  it("says nothing when nothing was replaced", () => {
    expect(transformNotice(RULE, [])).toBeUndefined();
    expect(transformNotice(null, [])).toBeUndefined();
    // `passthrough` is not a mechanism; a list of nothing but passthrough is
    // still a result the agent received untouched.
    expect(transformNotice(RULE, ["passthrough"])).toBeUndefined();
  });

  it("names the rule that did it", () => {
    const notice = transformNotice(RULE, ["tokenize"]) ?? "";
    expect(notice).toContain("Tokenize PHI on phi-tagged tools (phi-transform-default)");
    expect(
      notice.startsWith("Privacy notice: sensitive values in this result were replaced by"),
    ).toBe(true);
  });

  it("falls back to naming no rule rather than inventing one", () => {
    expect(transformNotice(null, ["tokenize"])).toContain("a WebMCP Guard policy");
  });

  it("explains tokens as stable, comparable identifiers", () => {
    const notice = transformNotice(RULE, ["tokenize"]) ?? "";
    expect(notice).toContain("tok_name_1a2b3c4d");
    expect(notice).toContain("always yields the same token");
    expect(notice).toContain("pass them back");
  });

  it.each<[string, TransformAction[], string[], string[]]>([
    ["tokens only", ["tokenize"], ["stable WebMCP Guard tokens"], ["Masked", "Generalized"]],
    ["masks only", ["mask"], ["Masked values (•••) cannot be recovered."], ["tok_name_1a2b3c4d"]],
    [
      "generalization only",
      ["contextualize"],
      ["Generalized values (age brackets, city/state) cannot be recovered."],
      ["tok_name_1a2b3c4d", "Masked values"],
    ],
    [
      "masks and generalization",
      ["mask", "contextualize"],
      [
        "Masked values (•••) and generalized values (age brackets, city/state) cannot be recovered.",
      ],
      ["tok_name_1a2b3c4d"],
    ],
  ])("mentions only the mechanisms used — %s", (_label, actions, present, absent) => {
    const notice = transformNotice(RULE, actions) ?? "";
    for (const fragment of present) expect(notice).toContain(fragment);
    for (const fragment of absent) expect(notice).not.toContain(fragment);
  });

  it("explains all three when all three ran", () => {
    const notice = transformNotice(RULE, ["tokenize", "mask", "contextualize"]) ?? "";
    expect(notice).toContain("tok_name_1a2b3c4d");
    expect(notice).toContain("Masked values (•••) and generalized values");
  });

  it("is one paragraph of plain prose — no JSON, no rule internals", () => {
    const notice = transformNotice(RULE, ["tokenize", "mask", "contextualize"]) ?? "";
    expect(notice).not.toContain("\n");
    expect(notice).not.toContain("{");
    expect(notice).not.toContain("perClass");
  });

  it("ignores a repeated mechanism", () => {
    expect(transformNotice(RULE, ["mask", "mask"])).toBe(transformNotice(RULE, ["mask"]));
  });
});
