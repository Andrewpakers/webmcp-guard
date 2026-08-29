import { describe, expect, it } from "vitest";

import {
  PORTAL_PERSONA_COOKIE,
  PORTAL_SESSION_COOKIE,
  parseCookieHeader,
  readPortalSession,
  verifySessionCookie,
  resolvePortalSessionSecret,
} from "@/lib/session/cookie";

import { GET, POST } from "./route";

/**
 * The mock login route. `process.env` is left alone: the portal's test run has
 * no `PORTAL_SESSION_SECRET`, so the route and these assertions both go through
 * the same committed dev key — which is exactly the path a clean clone takes.
 */

const URL_BASE = "http://localhost:3000/api/session";

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every `Set-Cookie` on a response, in order. */
function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

function cookieValue(header: string): string {
  return header.slice(header.indexOf("=") + 1, header.indexOf(";"));
}

describe("POST /api/session", () => {
  it("signs a session cookie for the requested persona", async () => {
    const response = await POST(postRequest({ persona: "sam-levin" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; persona: { role: string } };
    expect(body.ok).toBe(true);
    expect(body.persona.role).toBe("billing");

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);

    const session = cookies.find((cookie) => cookie.startsWith(`${PORTAL_SESSION_COOKIE}=`));
    const display = cookies.find((cookie) => cookie.startsWith(`${PORTAL_PERSONA_COOKIE}=`));
    if (session === undefined || display === undefined) throw new Error("missing cookies");

    expect(session).toContain("HttpOnly");
    expect(display).not.toContain("HttpOnly");

    const payload = verifySessionCookie(cookieValue(session), resolvePortalSessionSecret().secret);
    expect(payload).toMatchObject({ userId: "sam-levin", role: "billing" });
    expect(Number.isInteger(payload?.issuedAt)).toBe(true);
  });

  it("mints a cookie the guard's resolver reads back as the same persona", async () => {
    const response = await POST(postRequest({ persona: "nurse-okafor" }));
    const header = setCookies(response)
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const session = readPortalSession(
      new Request("http://localhost:3000/api/guard/gate", {
        headers: { cookie: header },
      }),
    );
    expect(session).toMatchObject({ source: "cookie", persona: { role: "nursing" } });
    // And the display cookie carries the same persona for the page to read.
    expect(parseCookieHeader(header)[PORTAL_PERSONA_COOKIE]).toBe("nurse-okafor");
  });

  it("marks the cookies Secure behind an https proxy", async () => {
    const response = await POST(
      postRequest({ persona: "dr-reyes" }, { "x-forwarded-proto": "https" }),
    );
    for (const cookie of setCookies(response)) expect(cookie).toContain("; Secure");
  });

  it("does not mark them Secure on plain http", async () => {
    const response = await POST(postRequest({ persona: "dr-reyes" }));
    for (const cookie of setCookies(response)) expect(cookie).not.toContain("; Secure");
  });

  it("refuses an unknown persona and sets nothing", async () => {
    const response = await POST(postRequest({ persona: "dr-nobody" }));
    expect(response.status).toBe(404);
    expect(setCookies(response)).toHaveLength(0);

    const body = (await response.json()) as { error: string };
    // The error names the choices — an agent or a developer can act on it.
    expect(body.error).toContain("dr-reyes, nurse-okafor, sam-levin");
  });

  it("rejects a missing field and a malformed body", async () => {
    expect((await POST(postRequest({}))).status).toBe(400);
    expect((await POST(postRequest("not json"))).status).toBe(400);
  });
});

describe("GET /api/session", () => {
  it("reports the default persona when no cookie has been set", async () => {
    const response = GET(new Request(URL_BASE));
    const body = (await response.json()) as {
      persona: { id: string };
      source: string;
      personas: { id: string }[];
    };

    expect(body.persona.id).toBe("dr-reyes");
    expect(body.source).toBe("default");
    expect(body.personas.map((persona) => persona.id)).toEqual([
      "dr-reyes",
      "nurse-okafor",
      "sam-levin",
    ]);
  });

  it("reports the signed persona when one is present", async () => {
    const signed = setCookies(await POST(postRequest({ persona: "sam-levin" })))
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const response = GET(new Request(URL_BASE, { headers: { cookie: signed } }));
    const body = (await response.json()) as { persona: { id: string }; source: string };
    expect(body).toMatchObject({ persona: { id: "sam-levin" }, source: "cookie" });
  });
});
