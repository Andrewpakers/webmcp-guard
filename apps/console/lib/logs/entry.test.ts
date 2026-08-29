import type { LogRecord } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  agentLabel,
  displayVerdict,
  formatDuration,
  readJustification,
  VERDICT_BADGE,
} from "./entry";

function entry(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "call-1",
    timestamp: "2026-08-29T18:04:05.123Z",
    app: "lakeside-portal",
    tool: "search_patients",
    verdict: "allow",
    agent: {},
    dataClasses: [],
    ruleIds: [],
    durationMs: 12,
    payloads: { argsBefore: {}, argsAfter: {}, resultBefore: {}, resultAfter: {} },
    status: "complete",
    ...overrides,
  } as LogRecord;
}

describe("displayVerdict", () => {
  it("shows a clean allow as allowed", () => {
    expect(displayVerdict(entry())).toBe("allowed");
  });

  it("derives `transformed` only from a payload that actually changed", () => {
    expect(
      displayVerdict(
        entry({
          dataClasses: ["ssn", "name"],
          payloads: { resultBefore: { ssn: "927-78-1337" }, resultAfter: { ssn: "tok_ssn_x" } },
        }),
      ),
    ).toBe("transformed");
  });

  it("shows `allowed` when classes were found but policy passed them through", () => {
    expect(
      displayVerdict(
        entry({
          dataClasses: ["ssn", "name"],
          payloads: { resultBefore: { ssn: "927-78-1337" }, resultAfter: { ssn: "927-78-1337" } },
        }),
      ),
    ).toBe("allowed");
  });

  it("counts inbound detokenization (args changed) as transformed", () => {
    expect(
      displayVerdict(
        entry({
          dataClasses: ["mrn"],
          payloads: { argsBefore: { patient: "tok_mrn_a" }, argsAfter: { patient: "LM-100028" } },
        }),
      ),
    ).toBe("transformed");
  });

  it("maps the gate vocabulary onto the console's labels", () => {
    expect(displayVerdict(entry({ verdict: "deny" }))).toBe("denied");
    expect(displayVerdict(entry({ verdict: "require-confirmation" }))).toBe("confirmed");
    expect(displayVerdict(entry({ verdict: "require-justification" }))).toBe("justified");
  });

  it("does not call a denied call transformed, whatever it touched", () => {
    expect(displayVerdict(entry({ verdict: "deny", dataClasses: ["ssn"] }))).toBe("denied");
  });

  it("has a badge style for every display verdict", () => {
    for (const verdict of ["allowed", "transformed", "denied", "confirmed", "justified"] as const) {
      expect(VERDICT_BADGE[verdict]).toBeTruthy();
    }
  });
});

describe("agentLabel", () => {
  it("prefers the best-effort agent id, with the browser as context", () => {
    expect(agentLabel({ agentId: "chatgpt-atlas", browserBrand: "Chrome", browserVersion: "151" })).toBe(
      "chatgpt-atlas · Chrome 151",
    );
  });

  it("falls back to the browser, then to `unidentified`", () => {
    expect(agentLabel({ browserBrand: "Chrome", browserVersion: "151" })).toBe("Chrome 151");
    expect(agentLabel({ browserBrand: "Chrome" })).toBe("Chrome");
    expect(agentLabel({})).toBe("unidentified");
  });
});

describe("formatDuration", () => {
  it("formats sub-second and multi-second durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(412)).toBe("412 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(65_000)).toBe("65.0 s");
  });

  it("renders nonsense as a dash", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("readJustification", () => {
  it("is null when the entry carries neither field", () => {
    expect(readJustification(entry())).toBeNull();
    expect(readJustification(null)).toBeNull();
  });

  it("reads the justification text", () => {
    expect(readJustification({ justification: "Patient asked for a copy of their chart." })).toEqual(
      { text: "Patient asked for a copy of their chart." },
    );
  });

  it("reads an evaluator verdict in either shape (Phase 5 fields)", () => {
    expect(readJustification({ justification: "why", justificationVerdict: "pass" })).toEqual({
      text: "why",
      verdict: "pass",
    });

    expect(
      readJustification({
        justification: "why",
        evaluator: { verdict: "fail", reason: "No patient or task referenced." },
      }),
    ).toEqual({ text: "why", verdict: "fail", reason: "No patient or task referenced." });
  });

  it("ignores a blank justification", () => {
    expect(readJustification({ justification: "   " })).toBeNull();
  });
});
