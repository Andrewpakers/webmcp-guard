import type { EffectivePolicy } from "@webmcp-guard/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JUSTIFICATION_PROPERTY,
  applyPolicyToSchema,
  justificationDescription,
  schemaSignature,
} from "./schema";

/**
 * Schema rewriting from policy (`docs/04` behavior 3). The two rules the module
 * header commits to — never mutate the host's object, and never change anything
 * without an answer from the server — are asserted here directly, because both
 * failures would be silent in production.
 */

const PLAIN: EffectivePolicy = {
  requiresJustification: false,
  minChars: null,
  requiresConfirmation: false,
  disabled: false,
};

const JUSTIFY: EffectivePolicy = { ...PLAIN, requiresJustification: true, minChars: 40 };

function exportSchema() {
  return {
    type: "object",
    properties: {
      condition: { type: "string", description: "Diagnosis fragment." },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["condition"],
    additionalProperties: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyPolicyToSchema", () => {
  it("leaves the schema alone when policy asks for nothing", () => {
    expect(applyPolicyToSchema(exportSchema(), PLAIN)).toEqual(exportSchema());
  });

  it("leaves the schema alone when the guard could not be reached", () => {
    // `null` means "no answer", which is not the same as "no requirement".
    expect(applyPolicyToSchema(exportSchema(), null)).toEqual(exportSchema());
  });

  it("injects a required justification property", () => {
    const rewritten = applyPolicyToSchema(exportSchema(), JUSTIFY);
    const properties = rewritten.properties as Record<string, Record<string, unknown>>;

    expect(properties[JUSTIFICATION_PROPERTY]).toEqual({
      type: "string",
      minLength: 40,
      description: justificationDescription(40),
    });
    expect(rewritten.required).toEqual(["condition", "justification"]);
    // Everything the host declared survives untouched.
    expect(properties.condition).toEqual({ type: "string", description: "Diagnosis fragment." });
    expect(rewritten.additionalProperties).toBe(false);
  });

  it("writes a description that tells the agent what a good answer contains", () => {
    const description = justificationDescription(40);
    expect(description).toContain("40 characters");
    expect(description).toContain("for whom");
    expect(description).toContain("audit log");
    expect(justificationDescription(null)).not.toContain("characters of real explanation");
  });

  it("never mutates the host's definition", () => {
    const host = exportSchema();
    const snapshot = JSON.parse(JSON.stringify(host)) as unknown;

    const rewritten = applyPolicyToSchema(host, JUSTIFY);

    expect(host).toEqual(snapshot);
    expect(rewritten).not.toBe(host);
    expect(rewritten.properties).not.toBe(host.properties);

    // …and a second pass over the same host object injects exactly once.
    const again = applyPolicyToSchema(host, JUSTIFY);
    expect(again.required).toEqual(["condition", "justification"]);
  });

  it("copies deeply, so editing the result cannot reach the host", () => {
    const host = exportSchema();
    const rewritten = applyPolicyToSchema(host, JUSTIFY);
    (rewritten.properties as Record<string, Record<string, unknown>>).condition.description =
      "hacked";

    expect(host.properties.condition.description).toBe("Diagnosis fragment.");
  });

  it("builds the object shape when the host schema had none", () => {
    const rewritten = applyPolicyToSchema({}, JUSTIFY);

    expect(rewritten.type).toBe("object");
    expect(Object.keys(rewritten.properties as object)).toEqual([JUSTIFICATION_PROPERTY]);
    expect(rewritten.required).toEqual([JUSTIFICATION_PROPERTY]);
  });

  it("does not add a minimum length when policy did not name one", () => {
    const rewritten = applyPolicyToSchema({}, { ...JUSTIFY, minChars: null });
    const property = (rewritten.properties as Record<string, Record<string, unknown>>)
      .justification;

    expect(property).not.toHaveProperty("minLength");
  });

  it("does not duplicate an already-required justification", () => {
    const rewritten = applyPolicyToSchema(
      { type: "object", properties: {}, required: ["justification", "condition"] },
      JUSTIFY,
    );
    expect(rewritten.required).toEqual(["condition", "justification"]);
  });

  it("warns when it shadows a justification field the host declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rewritten = applyPolicyToSchema(
      { type: "object", properties: { justification: { type: "number" } } },
      JUSTIFY,
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("already declares");
    expect(
      (rewritten.properties as Record<string, Record<string, unknown>>).justification.type,
    ).toBe("string");
  });

  it("ignores a malformed `required` rather than failing the registration", () => {
    const rewritten = applyPolicyToSchema(
      { type: "object", properties: {}, required: "condition" },
      JUSTIFY,
    );
    expect(rewritten.required).toEqual([JUSTIFICATION_PROPERTY]);
  });
});

describe("schemaSignature", () => {
  it("changes when the injected schema would change", () => {
    expect(schemaSignature(PLAIN)).not.toBe(schemaSignature(JUSTIFY));
    expect(schemaSignature(JUSTIFY)).not.toBe(schemaSignature({ ...JUSTIFY, minChars: 120 }));
  });

  it("does not change for policy that leaves the schema alone", () => {
    // A confirmation requirement is invisible in the tool list, so flipping it
    // must not churn every registered tool.
    expect(schemaSignature({ ...PLAIN, requiresConfirmation: true })).toBe(schemaSignature(PLAIN));
    expect(schemaSignature({ ...PLAIN, disabled: true })).toBe(schemaSignature(PLAIN));
  });

  it("distinguishes 'no answer' from 'no requirement'", () => {
    expect(schemaSignature(null)).not.toBe(schemaSignature(PLAIN));
  });
});
