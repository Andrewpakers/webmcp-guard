import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PORTAL_PERSONA_COOKIE,
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_DEV_DEFAULT,
  canonicalPayload,
  parseCookieHeader,
  personaCookieHeaders,
  personaFromSignedCookie,
  portalSessionContext,
  portalSessionSecretWarning,
  readPortalSession,
  resolvePortalSessionSecret,
  signSessionCookie,
  verifySessionCookie,
} from "./cookie";
import { DEFAULT_PERSONA, PERSONAS, findPersona, type Persona } from "./personas";

const SECRET = "test-session-secret-4b1f";

function requirePersona(id: string): Persona {
  const persona = findPersona(id);
  if (persona === undefined) throw new Error(`persona ${id} is missing`);
  return persona;
}

const BILLING = requirePersona("sam-levin");

function payload(overrides: Partial<{ userId: string; role: string; issuedAt: number }> = {}) {
  return {
    userId: BILLING.id,
    role: BILLING.role,
    issuedAt: 1_756_400_000_000,
    ...overrides,
  };
}

/** A validly-signed cookie over an arbitrary canonical string. */
function handSigned(canonical: string): string {
  const signature = createHmac("sha256", SECRET).update(canonical).digest("base64url");
  return `${Buffer.from(canonical, "utf8").toString("base64url")}.${signature}`;
}

function requestWith(cookie: string | undefined): Request {
  return new Request("http://localhost:3000/api/guard/gate", {
    headers: cookie === undefined ? {} : { cookie },
  });
}

describe("resolvePortalSessionSecret", () => {
  it("prefers PORTAL_SESSION_SECRET", () => {
    const resolved = resolvePortalSessionSecret({
      PORTAL_SESSION_SECRET: "portal",
      GUARD_ORG_SECRET: "org",
    });
    expect(resolved.source).toBe("PORTAL_SESSION_SECRET");
    expect(resolved.fellBack).toBe(false);
  });

  it("derives from GUARD_ORG_SECRET when the portal key is unset", () => {
    const resolved = resolvePortalSessionSecret({ GUARD_ORG_SECRET: "org" });
    expect(resolved.source).toBe("GUARD_ORG_SECRET");
    expect(resolved.fellBack).toBe(false);
    // Derived, never the org secret itself: the token HMAC key and the cookie
    // key must not be the same string.
    expect(resolved.secret).not.toBe("org");
    expect(resolved.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the committed dev key, and says so", () => {
    const resolved = resolvePortalSessionSecret({});
    expect(resolved.source).toBe("development default");
    expect(resolved.fellBack).toBe(true);
    expect(resolved.secret).not.toBe(PORTAL_SESSION_DEV_DEFAULT);
    expect(portalSessionSecretWarning()).toMatch(/development key/i);
  });

  it("derives a different key from every base secret", () => {
    const a = resolvePortalSessionSecret({ PORTAL_SESSION_SECRET: "a" }).secret;
    const b = resolvePortalSessionSecret({ PORTAL_SESSION_SECRET: "b" }).secret;
    expect(a).not.toBe(b);
  });
});

describe("signSessionCookie / verifySessionCookie", () => {
  it("round-trips a payload", () => {
    const signed = signSessionCookie(payload(), SECRET);
    expect(signed.split(".")).toHaveLength(2);
    expect(verifySessionCookie(signed, SECRET)).toEqual(payload());
  });

  it("signs the canonical userId.role.issuedAt string", () => {
    expect(canonicalPayload(payload())).toBe(`sam-levin.billing.${payload().issuedAt}`);
  });

  it("is deterministic for the same payload and key", () => {
    expect(signSessionCookie(payload(), SECRET)).toBe(signSessionCookie(payload(), SECRET));
  });

  it("rejects a payload edited under an untouched signature", () => {
    const signed = signSessionCookie(payload(), SECRET);
    const [, signature] = signed.split(".");
    const forged = `${Buffer.from("dr-reyes.physician.1756400000000", "utf8").toString("base64url")}.${signature}`;

    expect(verifySessionCookie(forged, SECRET)).toBeNull();
  });

  it("rejects a flipped signature", () => {
    const signed = signSessionCookie(payload(), SECRET);
    const [encoded, signature] = signed.split(".");
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    expect(verifySessionCookie(`${encoded}.${flipped}`, SECRET)).toBeNull();
  });

  it("rejects a signature from a different key", () => {
    const signed = signSessionCookie(payload(), "another-secret");
    expect(verifySessionCookie(signed, SECRET)).toBeNull();
  });

  it("rejects a truncated signature rather than throwing", () => {
    const signed = signSessionCookie(payload(), SECRET);
    const [encoded, signature] = signed.split(".");
    expect(verifySessionCookie(`${encoded}.${signature.slice(0, 10)}`, SECRET)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["no signature", "eyJ"],
    ["too many segments", "a.b.c"],
    ["empty payload", ".abc"],
  ])("rejects a malformed value (%s)", (_label, value) => {
    expect(verifySessionCookie(value, SECRET)).toBeNull();
  });

  it("rejects a payload that is not three dot-separated fields", () => {
    expect(verifySessionCookie(handSigned("sam-levin.billing"), SECRET)).toBeNull();
  });

  it("rejects a non-numeric issuedAt even when the signature is valid", () => {
    expect(verifySessionCookie(handSigned("sam-levin.billing.yesterday"), SECRET)).toBeNull();
  });

  /**
   * Documented design, not an oversight: the mock login has no session lifetime
   * (see the module docblock and `docs/01` — real SSO is out of scope). A cookie
   * minted years ago still verifies, and a judge's session never expires
   * mid-recording. Change this test the day a real IdP replaces the personas.
   */
  it("has no expiry: a very old issuedAt still verifies", () => {
    const ancient = signSessionCookie(payload({ issuedAt: 1_000_000_000_000 }), SECRET);
    expect(verifySessionCookie(ancient, SECRET)?.issuedAt).toBe(1_000_000_000_000);
  });
});

describe("parseCookieHeader", () => {
  it("parses a normal header", () => {
    expect(parseCookieHeader("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("decodes percent-encoded values and tolerates junk", () => {
    expect(parseCookieHeader("name=Sam%20Levin; broken; =2; c=")).toEqual({
      name: "Sam Levin",
      c: "",
    });
  });

  it("returns an empty object for nothing at all", () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });
});

describe("readPortalSession", () => {
  const env = { PORTAL_SESSION_SECRET: SECRET };
  const signedBilling = signSessionCookie(payload(), resolvePortalSessionSecret(env).secret);

  it("resolves the signed persona", () => {
    const session = readPortalSession(
      requestWith(`${PORTAL_SESSION_COOKIE}=${signedBilling}`),
      env,
    );
    expect(session).toEqual({ persona: BILLING, source: "cookie" });
  });

  it("falls back to the default persona with no cookie", () => {
    expect(readPortalSession(requestWith(undefined), env)).toEqual({
      persona: DEFAULT_PERSONA,
      source: "default",
    });
  });

  it("falls back to the default persona on a tampered cookie", () => {
    const tampered = `${signedBilling.slice(0, -2)}xy`;
    expect(readPortalSession(requestWith(`${PORTAL_SESSION_COOKIE}=${tampered}`), env)).toEqual({
      persona: DEFAULT_PERSONA,
      source: "default",
    });
  });

  it("falls back when the cookie was signed with a different key", () => {
    expect(
      readPortalSession(requestWith(`${PORTAL_SESSION_COOKIE}=${signedBilling}`), {
        PORTAL_SESSION_SECRET: "rotated",
      }),
    ).toEqual({ persona: DEFAULT_PERSONA, source: "default" });
  });

  it("refuses a validly-signed cookie for a persona that does not exist", () => {
    const ghost = signSessionCookie(
      payload({ userId: "dr-nobody", role: "billing" }),
      resolvePortalSessionSecret(env).secret,
    );
    expect(personaFromSignedCookie(ghost, env).source).toBe("default");
  });

  it("refuses a validly-signed cookie whose role no longer matches the persona", () => {
    const escalated = signSessionCookie(
      payload({ userId: "sam-levin", role: "physician" }),
      resolvePortalSessionSecret(env).secret,
    );
    expect(personaFromSignedCookie(escalated, env).persona).toEqual(DEFAULT_PERSONA);
  });

  it("hands the guard a { userId, role } session context", () => {
    expect(
      portalSessionContext(requestWith(`${PORTAL_SESSION_COOKIE}=${signedBilling}`), env),
    ).toEqual({ userId: "sam-levin", role: "billing" });
    expect(portalSessionContext(requestWith(undefined), env)).toEqual({
      userId: DEFAULT_PERSONA.id,
      role: DEFAULT_PERSONA.role,
    });
  });
});

describe("personaCookieHeaders", () => {
  it("writes a signed httpOnly cookie plus a page-readable display cookie", () => {
    const [session, display] = personaCookieHeaders(BILLING, {
      secure: false,
      secret: SECRET,
      now: 1_756_400_000_000,
    });

    expect(session).toContain(`${PORTAL_SESSION_COOKIE}=`);
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    expect(session).not.toContain("Secure");

    expect(display).toBe(`${PORTAL_PERSONA_COOKIE}=sam-levin; Path=/; SameSite=Lax`);
    expect(display).not.toContain("HttpOnly");
  });

  it("adds Secure when the request came in over https", () => {
    const [session, display] = personaCookieHeaders(BILLING, { secure: true, secret: SECRET });
    expect(session).toContain("; Secure");
    expect(display).toContain("; Secure");
  });

  it("round-trips through readPortalSession for every persona", () => {
    // `secret` here is the *derived* signing key, the same value
    // `readPortalSession` will derive from the environment below.
    const env = { PORTAL_SESSION_SECRET: SECRET };
    const secret = resolvePortalSessionSecret(env).secret;

    for (const persona of PERSONAS) {
      const [session] = personaCookieHeaders(persona, { secure: false, secret });
      const value = session.slice(session.indexOf("=") + 1, session.indexOf(";"));
      expect(
        readPortalSession(requestWith(`${PORTAL_SESSION_COOKIE}=${value}`), env).persona,
      ).toEqual(persona);
    }
  });

  it("does not carry an expiry (no Max-Age, no Expires)", () => {
    for (const header of personaCookieHeaders(BILLING, { secure: false, secret: SECRET })) {
      expect(header).not.toMatch(/max-age|expires/i);
    }
  });
});
