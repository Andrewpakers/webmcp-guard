import { describe, expect, it } from "vitest";

import { UNAUTHORIZED_MESSAGE, bearerToken, isAdminRequest, secretsMatch } from "./auth";

function requestWith(authorization?: string): Request {
  return new Request("https://portal.test/api/guard/logs", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("secretsMatch", () => {
  it("accepts identical secrets", () => {
    expect(secretsMatch("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects near misses, prefixes and case differences", () => {
    expect(secretsMatch("s3cret-toke", "s3cret-token")).toBe(false);
    expect(secretsMatch("s3cret-tokenn", "s3cret-token")).toBe(false);
    expect(secretsMatch("S3CRET-TOKEN", "s3cret-token")).toBe(false);
    expect(secretsMatch("", "s3cret-token")).toBe(false);
  });

  it("compares different lengths without throwing (hashed first)", () => {
    expect(secretsMatch("a", "a-much-longer-token-value")).toBe(false);
    expect(secretsMatch("🙂".repeat(100), "x")).toBe(false);
  });

  it("handles non-ASCII secrets", () => {
    expect(secretsMatch("pässwörd-✓", "pässwörd-✓")).toBe(true);
    expect(secretsMatch("pässwörd-✓", "passwörd-✓")).toBe(false);
  });
});

describe("bearerToken", () => {
  it("reads the token from a Bearer header, case-insensitively", () => {
    expect(bearerToken(requestWith("Bearer abc123"))).toBe("abc123");
    expect(bearerToken(requestWith("bearer abc123"))).toBe("abc123");
    expect(bearerToken(requestWith("BEARER   abc123  "))).toBe("abc123");
  });

  it("returns null for anything else", () => {
    expect(bearerToken(requestWith())).toBeNull();
    expect(bearerToken(requestWith("Basic abc123"))).toBeNull();
    expect(bearerToken(requestWith("Bearer"))).toBeNull();
    expect(bearerToken(requestWith("Bearer "))).toBeNull();
    expect(bearerToken(requestWith("abc123"))).toBeNull();
  });
});

describe("isAdminRequest", () => {
  it("accepts the configured token and nothing else", () => {
    expect(isAdminRequest(requestWith("Bearer admin-token"), "admin-token")).toBe(true);
    expect(isAdminRequest(requestWith("Bearer admin-toke"), "admin-token")).toBe(false);
    expect(isAdminRequest(requestWith(), "admin-token")).toBe(false);
  });
});

describe("UNAUTHORIZED_MESSAGE", () => {
  it("says how to authenticate without hinting at the token", () => {
    expect(UNAUTHORIZED_MESSAGE).toContain("Authorization: Bearer");
    expect(UNAUTHORIZED_MESSAGE).not.toMatch(/invalid|wrong|incorrect|expired/i);
  });
});
