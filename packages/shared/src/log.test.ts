import { describe, expect, it } from "vitest";

import { LogEntrySchema, type LogEntryInput } from "./log";

const entry: LogEntryInput = {
  id: "log_01",
  timestamp: "2026-08-29T12:00:01.250Z",
  app: "lakeside-portal",
  tool: "get_patient",
  verdict: "allow",
  agent: {
    agentId: "chatgpt-atlas",
    browserBrand: "Chromium",
    browserVersion: "149",
    platform: "macOS",
    isSecureContext: true,
  },
  session: { userId: "u-1", role: "clinician" },
  dataClasses: ["mrn", "name", "ssn"],
  ruleIds: ["P-1", "P-3"],
  durationMs: 42,
  payloads: {
    argsBefore: { patientId: "tok_mrn_8f3a2c19" },
    argsAfter: { patientId: "MRN-00042" },
    resultBefore: { name: "Dana Vasquez", ssn: "123-45-6789" },
    resultAfter: { name: "tok_name_1b2c3d4e", ssn: "tok_ssn_9e8d7c6b" },
  },
};

describe("LogEntrySchema", () => {
  it("accepts a complete entry", () => {
    const parsed = LogEntrySchema.parse(entry);
    expect(parsed.ruleIds).toEqual(["P-1", "P-3"]);
    expect(parsed.payloads.resultAfter).toEqual({
      name: "tok_name_1b2c3d4e",
      ssn: "tok_ssn_9e8d7c6b",
    });
  });

  it("accepts a denied call carrying the message and justification", () => {
    const parsed = LogEntrySchema.parse({
      ...entry,
      verdict: "deny",
      message: "blocked by policy P-7: destructive actions require justification",
      justification: "Patient requested deletion of their record.",
    });
    expect(parsed.verdict).toBe("deny");
    expect(parsed.justification).toContain("Patient requested");
  });

  it("accepts an entry from an unidentified agent", () => {
    const parsed = LogEntrySchema.parse({ ...entry, agent: {} });
    expect(parsed.agent).toEqual({});
  });

  it("rejects an unknown verdict", () => {
    expect(LogEntrySchema.safeParse({ ...entry, verdict: "allowed" }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(LogEntrySchema.safeParse({ ...entry, timestamp: "yesterday" }).success).toBe(false);
  });

  it("rejects a negative duration", () => {
    expect(LogEntrySchema.safeParse({ ...entry, durationMs: -1 }).success).toBe(false);
  });

  it("rejects an unknown data class", () => {
    expect(LogEntrySchema.safeParse({ ...entry, dataClasses: ["passport"] }).success).toBe(false);
  });

  it("rejects an entry missing its payloads", () => {
    const { payloads: _payloads, ...withoutPayloads } = entry;
    expect(LogEntrySchema.safeParse(withoutPayloads).success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(LogEntrySchema.safeParse({ ...entry, note: "extra" }).success).toBe(false);
  });

  it("rejects unknown keys inside agent info", () => {
    expect(
      LogEntrySchema.safeParse({ ...entry, agent: { agentId: "x", ip: "1.2.3.4" } }).success,
    ).toBe(false);
  });
});
