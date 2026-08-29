import { describe, expect, it } from "vitest";

import {
  GateRequestEnvelopeSchema,
  GateRequestSchema,
  GateResponseSchema,
  PostureSnapshotSchema,
  TransformRequestSchema,
  TransformResponseSchema,
  WIRE_VERSION,
  type GateRequest,
  type PostureSnapshot,
} from "./wire";

const posture: PostureSnapshot = {
  brands: [{ brand: "Chromium", version: "149" }],
  platform: "macOS",
  mobile: false,
  isSecureContext: true,
  viewport: { width: 1440, height: 900 },
  agentId: "chatgpt-atlas",
  timestamp: "2026-08-29T12:00:00.000Z",
};

const gateRequest: GateRequest = {
  app: "lakeside-portal",
  tool: "get_patient",
  args: { patientId: "tok_mrn_8f3a2c19" },
  posture,
  sessionContext: { userId: "u-1", role: "clinician" },
};

describe("PostureSnapshotSchema", () => {
  it("accepts a full snapshot", () => {
    expect(PostureSnapshotSchema.parse(posture)).toEqual(posture);
  });

  it("accepts a minimal snapshot (Client Hints unavailable)", () => {
    const minimal = {
      userAgent: "Mozilla/5.0",
      isSecureContext: false,
      timestamp: "2026-08-29T12:00:00Z",
    };
    expect(PostureSnapshotSchema.parse(minimal)).toEqual(minimal);
  });

  it("requires isSecureContext", () => {
    expect(PostureSnapshotSchema.safeParse({ timestamp: posture.timestamp }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(PostureSnapshotSchema.safeParse({ ...posture, timestamp: "29/08/2026" }).success).toBe(
      false,
    );
  });

  it("rejects a negative viewport", () => {
    expect(
      PostureSnapshotSchema.safeParse({ ...posture, viewport: { width: -1, height: 900 } }).success,
    ).toBe(false);
  });
});

describe("GateRequestSchema", () => {
  it("accepts a full request", () => {
    expect(GateRequestSchema.parse(gateRequest)).toEqual(gateRequest);
  });

  it("accepts a request with no posture or session (degraded client)", () => {
    const bare = { app: "lakeside-portal", tool: "search_patients", args: {} };
    expect(GateRequestSchema.parse(bare)).toEqual(bare);
  });

  it("accepts a confirmation follow-up", () => {
    const parsed = GateRequestSchema.parse({ ...gateRequest, confirmationId: "cnf_1" });
    expect(parsed.confirmationId).toBe("cnf_1");
  });

  it("rejects a missing tool name", () => {
    const { tool: _tool, ...withoutTool } = gateRequest;
    expect(GateRequestSchema.safeParse(withoutTool).success).toBe(false);
  });

  it("rejects args that are not a JSON object", () => {
    expect(GateRequestSchema.safeParse({ ...gateRequest, args: ["a"] }).success).toBe(false);
    expect(GateRequestSchema.safeParse({ ...gateRequest, args: "a" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(GateRequestSchema.safeParse({ ...gateRequest, bypass: true }).success).toBe(false);
  });
});

describe("GateResponseSchema", () => {
  it("accepts an allow with detokenized args", () => {
    const parsed = GateResponseSchema.parse({
      verdict: "allow",
      args: { patientId: "MRN-00042" },
      ruleIds: ["P-3"],
    });
    expect(parsed.verdict).toBe("allow");
    expect(parsed.args).toEqual({ patientId: "MRN-00042" });
  });

  it("accepts a deny with an agent-legible message", () => {
    const parsed = GateResponseSchema.parse({
      verdict: "deny",
      message: "blocked by policy P-7: destructive actions require justification",
      ruleIds: ["P-7"],
    });
    expect(parsed.message).toContain("P-7");
  });

  it("accepts a require-confirmation with a one-time id", () => {
    const parsed = GateResponseSchema.parse({
      verdict: "require-confirmation",
      message: "A person must approve this deletion.",
      confirmationId: "cnf_abc",
      ruleIds: ["P-9"],
    });
    expect(parsed.confirmationId).toBe("cnf_abc");
  });

  it("requires ruleIds so every decision is attributable", () => {
    expect(GateResponseSchema.safeParse({ verdict: "allow" }).success).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(GateResponseSchema.safeParse({ verdict: "maybe", ruleIds: [] }).success).toBe(false);
  });
});

describe("transform payloads", () => {
  it("accepts a transform request with an arbitrary result shape", () => {
    const parsed = TransformRequestSchema.parse({
      app: "lakeside-portal",
      tool: "search_patients",
      callId: "call_1",
      result: [{ mrn: "MRN-00042", name: "Dana Vasquez" }],
    });
    expect(parsed.callId).toBe("call_1");
  });

  it("rejects a transform request without an app", () => {
    expect(TransformRequestSchema.safeParse({ tool: "x", result: null }).success).toBe(false);
  });

  it("accepts a transform response reporting the classes it found", () => {
    const parsed = TransformResponseSchema.parse({
      result: [{ mrn: "tok_mrn_8f3a2c19", name: "tok_name_1b2c3d4e" }],
      classesFound: ["mrn", "name"],
      ruleIds: ["P-1"],
    });
    expect(parsed.classesFound).toEqual(["mrn", "name"]);
  });

  it("rejects a transform response with an unknown data class", () => {
    expect(
      TransformResponseSchema.safeParse({ result: {}, classesFound: ["passport"], ruleIds: [] })
        .success,
    ).toBe(false);
  });
});

describe("wire envelope", () => {
  it("wraps a payload with the current version", () => {
    const parsed = GateRequestEnvelopeSchema.parse({
      version: WIRE_VERSION,
      payload: gateRequest,
    });
    expect(parsed.version).toBe(1);
    expect(parsed.payload.tool).toBe("get_patient");
  });

  it("rejects an unsupported wire version", () => {
    expect(GateRequestEnvelopeSchema.safeParse({ version: 2, payload: gateRequest }).success).toBe(
      false,
    );
  });

  it("rejects an unwrapped payload", () => {
    expect(GateRequestEnvelopeSchema.safeParse(gateRequest).success).toBe(false);
  });

  it("rejects an invalid payload inside a valid envelope", () => {
    expect(GateRequestEnvelopeSchema.safeParse({ version: 1, payload: { app: "x" } }).success).toBe(
      false,
    );
  });
});
