import { WIRE_VERSION } from "@webmcp-guard/shared";
import { describe, expect, it, vi } from "vitest";

import {
  GuardApiError,
  buildQueryString,
  errorMessage,
  guardRequest,
  joinUrl,
  type FetchLike,
} from "./client";

const BASE = "http://localhost:3000/api/guard";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(payload: unknown, status = 200): Response {
  return jsonResponse({ version: WIRE_VERSION, payload }, status);
}

function errorEnvelope(code: string, message: string, status: number): Response {
  return jsonResponse({ version: WIRE_VERSION, error: { code, message } }, status);
}

function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { impl, calls };
}

describe("joinUrl", () => {
  it("joins a base and a path with exactly one slash", () => {
    expect(joinUrl(BASE, "/logs")).toBe(`${BASE}/logs`);
    expect(joinUrl(`${BASE}/`, "/logs")).toBe(`${BASE}/logs`);
    expect(joinUrl(`${BASE}//`, "logs")).toBe(`${BASE}/logs`);
  });
});

describe("buildQueryString", () => {
  it("drops undefined, null and blank values", () => {
    expect(
      buildQueryString({ tool: "search", verdict: undefined, agent: "", app: null, limit: 50 }),
    ).toBe("?tool=search&limit=50");
  });

  it("returns an empty string when nothing survives", () => {
    expect(buildQueryString({ tool: "   " })).toBe("");
    expect(buildQueryString(undefined)).toBe("");
  });

  it("encodes values", () => {
    expect(buildQueryString({ since: "2026-08-29T12:00:00.000Z" })).toBe(
      "?since=2026-08-29T12%3A00%3A00.000Z",
    );
  });
});

describe("guardRequest", () => {
  it("unwraps the versioned envelope", async () => {
    const { impl, calls } = stubFetch(envelope({ totalCalls: 3 }));
    const payload = await guardRequest<{ totalCalls: number }>(
      { baseUrl: BASE, token: "admin-token", fetchImpl: impl },
      { path: "/stats", query: { since: "2026-08-29" } },
    );

    expect(payload).toEqual({ totalCalls: 3 });
    expect(calls[0].url).toBe(`${BASE}/stats?since=2026-08-29`);
    expect(calls[0].init?.method).toBe("GET");
  });

  it("attaches the bearer token to every request", async () => {
    const { impl, calls } = stubFetch(envelope({}));
    await guardRequest({ baseUrl: BASE, token: "s3cret", fetchImpl: impl }, { path: "/policies" });

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
  });

  it("wraps request bodies in the wire envelope", async () => {
    const { impl, calls } = stubFetch(envelope({ id: "r1" }, 201));
    await guardRequest(
      { baseUrl: BASE, token: "t", fetchImpl: impl },
      { method: "POST", path: "/policies", body: { name: "Rule" } },
    );

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      version: WIRE_VERSION,
      payload: { name: "Rule" },
    });
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("maps a { version, error } body onto GuardApiError", async () => {
    const { impl } = stubFetch(errorEnvelope("not_found", 'No policy rule with id "nope".', 404));

    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/policies/nope" }),
    ).rejects.toMatchObject({
      name: "GuardApiError",
      code: "not_found",
      status: 404,
      message: 'No policy rule with id "nope".',
    });
  });

  it("falls back to the status when the error body is unusable", async () => {
    const { impl } = stubFetch(new Response("<html>gateway</html>", { status: 502 }));

    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/logs" }),
    ).rejects.toMatchObject({ code: "internal_error", status: 502 });
  });

  it("calls onUnauthorized once on a 401 and still rejects", async () => {
    const { impl } = stubFetch(errorEnvelope("unauthorized", "Admin token required.", 401));
    const onUnauthorized = vi.fn();

    await expect(
      guardRequest(
        { baseUrl: BASE, token: "stale", fetchImpl: impl, onUnauthorized },
        { path: "/logs" },
      ),
    ).rejects.toBeInstanceOf(GuardApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized.mock.calls[0][0]).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("treats a bare 401 with no envelope as unauthorized", async () => {
    const { impl } = stubFetch(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();

    await expect(
      guardRequest(
        { baseUrl: BASE, token: "stale", fetchImpl: impl, onUnauthorized },
        { path: "/logs" },
      ),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("never issues a request without a token", async () => {
    const { impl, calls } = stubFetch(envelope({}));
    const onUnauthorized = vi.fn();

    await expect(
      guardRequest(
        { baseUrl: BASE, token: null, fetchImpl: impl, onUnauthorized },
        { path: "/logs" },
      ),
    ).rejects.toMatchObject({ code: "no_token" });

    expect(calls).toHaveLength(0);
    // `no_token` is not a 401 from the server, so it must not bounce the session.
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("turns a fetch rejection into a network error naming the endpoint", async () => {
    const impl: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };

    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/stats" }),
    ).rejects.toMatchObject({ code: "network", status: 0 });

    await guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/stats" }).catch(
      (error: unknown) => {
        expect(errorMessage(error)).toContain(BASE);
        expect(errorMessage(error)).toContain("Failed to fetch");
      },
    );
  });

  it("rejects a 200 that is not a guard envelope", async () => {
    const { impl } = stubFetch(jsonResponse({ hello: "world" }));

    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/stats" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects an envelope from a different wire version", async () => {
    const { impl } = stubFetch(jsonResponse({ version: 99, payload: {} }));

    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/stats" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts a null payload (a valid envelope member)", async () => {
    const { impl } = stubFetch(envelope(null));
    await expect(
      guardRequest({ baseUrl: BASE, token: "t", fetchImpl: impl }, { path: "/stats" }),
    ).resolves.toBeNull();
  });
});

describe("errorMessage", () => {
  it("reads guard errors, plain errors and anything else", () => {
    expect(errorMessage(new GuardApiError("conflict", "Rule id already used."))).toBe(
      "Rule id already used.",
    );
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
  });
});
