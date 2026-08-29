import type { ConfirmationEntry } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_TTL_MS,
  canonicalJson,
  hashCallArgs,
  validateConfirmation,
} from "./confirmation";

const APP = "lakeside-portal";
const TOOL = "delete_patient";
const ARGS = { patient: "LM-100060" };
const NOW = Date.parse("2026-08-29T12:00:00.000Z");

function entry(overrides: Partial<ConfirmationEntry> = {}): ConfirmationEntry {
  return {
    id: "conf-1",
    app: APP,
    tool: TOOL,
    argsHash: hashCallArgs(APP, TOOL, ARGS),
    callId: "call-1",
    issuedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + CONFIRMATION_TTL_MS).toISOString(),
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts object keys at every depth, so key order cannot change the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    );
  });

  it("keeps array order, because order changes the call", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });

  it("drops undefined members, exactly as the wire does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
  });

  it("passes primitives and null through", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(7)).toBe("7");
  });
});

describe("hashCallArgs", () => {
  it("is a stable hex SHA-256", () => {
    const hash = hashCallArgs(APP, TOOL, ARGS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCallArgs(APP, TOOL, { patient: "LM-100060" })).toBe(hash);
    expect(hashCallArgs(APP, TOOL, { patient: "LM-100060", extra: undefined })).toBe(hash);
  });

  it("binds the app and the tool as well as the arguments", () => {
    const hash = hashCallArgs(APP, TOOL, ARGS);
    expect(hashCallArgs("other-app", TOOL, ARGS)).not.toBe(hash);
    expect(hashCallArgs(APP, "export_patients", ARGS)).not.toBe(hash);
    expect(hashCallArgs(APP, TOOL, { patient: "LM-100061" })).not.toBe(hash);
  });

  it("does not care what order the agent serialised its arguments in", () => {
    expect(hashCallArgs(APP, TOOL, { a: 1, b: 2 })).toBe(hashCallArgs(APP, TOOL, { b: 2, a: 1 }));
  });
});

describe("validateConfirmation", () => {
  const call = { app: APP, tool: TOOL, args: ARGS };

  it("accepts an unexpired approval for the same call", () => {
    expect(validateConfirmation(entry(), call, NOW + 1000)).toBeNull();
  });

  it("refuses an id that was never issued or is already spent", () => {
    expect(validateConfirmation(null, call, NOW)).toBe("unknown-or-used");
  });

  it("refuses an approval issued for a different tool or app", () => {
    expect(validateConfirmation(entry({ tool: "export_patients" }), call, NOW)).toBe(
      "different-call",
    );
    expect(validateConfirmation(entry({ app: "other-app" }), call, NOW)).toBe("different-call");
  });

  it("refuses an expired approval, inclusive of the expiry instant", () => {
    expect(validateConfirmation(entry(), call, NOW + CONFIRMATION_TTL_MS)).toBeNull();
    expect(validateConfirmation(entry(), call, NOW + CONFIRMATION_TTL_MS + 1)).toBe("expired");
  });

  it("treats an unreadable expiry as expired", () => {
    expect(validateConfirmation(entry({ expiresAt: "not a date" }), call, NOW)).toBe("expired");
  });

  it("refuses arguments that changed after the person saw them", () => {
    expect(validateConfirmation(entry(), { ...call, args: { patient: "LM-100061" } }, NOW)).toBe(
      "arguments-changed",
    );
    expect(
      validateConfirmation(entry(), { ...call, args: { patient: "LM-100060", force: true } }, NOW),
    ).toBe("arguments-changed");
  });

  it("accepts the same arguments serialised differently", () => {
    const reordered = { app: APP, tool: TOOL, args: { patient: "LM-100060" } };
    expect(validateConfirmation(entry(), reordered, NOW)).toBeNull();
  });

  it("checks identity before expiry, so a stale id reads as already spent", () => {
    // Ordering matters only for the message the agent gets; the id is destroyed
    // before any of this runs either way.
    expect(validateConfirmation(null, call, NOW + CONFIRMATION_TTL_MS * 10)).toBe(
      "unknown-or-used",
    );
  });
});
