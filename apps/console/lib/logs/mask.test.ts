import { describe, expect, it } from "vitest";

import { formatJson, isEmptyPayload, maskDeep, payloadView } from "./mask";

const ORIGINAL = {
  patient: {
    name: "Marisol Vandergrift",
    ssn: "123-45-6789",
    visits: 4,
    active: true,
    tags: ["cardiology", "priority"],
    discharged: null,
  },
};

describe("maskDeep", () => {
  it("keeps the structure and hides every string and number leaf", () => {
    const masked = maskDeep(ORIGINAL) as typeof ORIGINAL;

    expect(Object.keys(masked)).toEqual(["patient"]);
    expect(Object.keys(masked.patient)).toEqual(Object.keys(ORIGINAL.patient));
    expect(masked.patient.name).toBe("••••••");
    expect(masked.patient.ssn).toBe("••••••");
    expect(masked.patient.visits as unknown).toBe("••••••");
    expect(masked.patient.tags).toEqual(["••••••", "••••••"]);
  });

  it("leaves booleans, nulls and empty strings alone — they carry no PHI", () => {
    const masked = maskDeep(ORIGINAL) as typeof ORIGINAL;
    expect(masked.patient.active).toBe(true);
    expect(masked.patient.discharged).toBeNull();
    expect(maskDeep("")).toBe("");
  });

  it("does not mutate the original", () => {
    maskDeep(ORIGINAL);
    expect(ORIGINAL.patient.ssn).toBe("123-45-6789");
  });

  it("masks values of the same length identically, so nothing leaks through width", () => {
    expect(maskDeep("a")).toBe(maskDeep("a much longer secret value"));
  });
});

describe("payloadView", () => {
  it("masks the original half until it is revealed", () => {
    const hidden = payloadView(ORIGINAL, { sensitive: true, revealed: false });
    expect(hidden).not.toContain("123-45-6789");
    expect(hidden).toContain("ssn");
    expect(hidden).toContain("••••••");
  });

  it("shows the original half once revealed", () => {
    const shown = payloadView(ORIGINAL, { sensitive: true, revealed: true });
    expect(shown).toContain("123-45-6789");
  });

  it("never masks the half the agent actually received", () => {
    const after = { patient: { ssn: "tok_ssn_9f2ab3c1" } };
    expect(payloadView(after, { sensitive: false, revealed: false })).toContain("tok_ssn_9f2ab3c1");
  });

  it("pretty-prints", () => {
    expect(payloadView({ a: 1 }, { sensitive: false, revealed: false })).toBe('{\n  "a": 1\n}');
  });
});

describe("formatJson / isEmptyPayload", () => {
  it("labels a half that was never recorded", () => {
    expect(formatJson(undefined)).toBe("— not recorded —");
  });

  it("survives a circular value instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatJson(circular)).not.toThrow();
  });

  it("recognises the empty halves", () => {
    expect(isEmptyPayload(undefined)).toBe(true);
    expect(isEmptyPayload(null)).toBe(true);
    expect(isEmptyPayload({})).toBe(true);
    expect(isEmptyPayload([])).toBe(true);
    expect(isEmptyPayload({ a: 1 })).toBe(false);
    expect(isEmptyPayload(0)).toBe(false);
  });
});
