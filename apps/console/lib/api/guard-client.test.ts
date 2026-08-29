import { WIRE_VERSION } from "@webmcp-guard/shared";
import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./client";
import { createGuardClient, logQueryParams, statsParams } from "./guard-client";

const BASE = "http://portal.test/api/guard";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  };
  return { impl, calls };
}

function ok(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify({ version: WIRE_VERSION, payload }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(code: string, status: number): Response {
  return new Response(JSON.stringify({ version: WIRE_VERSION, error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("logQueryParams", () => {
  it("renames agentId to the `agent` parameter the server names", () => {
    expect(logQueryParams({ agentId: "chatgpt-atlas" })).toMatchObject({
      agent: "chatgpt-atlas",
    });
  });

  it("passes every other filter through untouched", () => {
    expect(
      logQueryParams({
        tool: "search_patients",
        verdict: "deny",
        dataClass: "ssn",
        status: "complete",
        since: "2026-08-29T00:00:00.000Z",
        until: "2026-08-30T00:00:00.000Z",
        limit: 25,
        offset: 50,
      }),
    ).toMatchObject({
      tool: "search_patients",
      verdict: "deny",
      dataClass: "ssn",
      status: "complete",
      since: "2026-08-29T00:00:00.000Z",
      until: "2026-08-30T00:00:00.000Z",
      limit: 25,
      offset: 50,
    });
  });

  it("is empty for an absent query", () => {
    expect(logQueryParams(undefined)).toEqual({});
    expect(statsParams(undefined)).toEqual({ since: undefined, until: undefined });
  });
});

describe("createGuardClient", () => {
  it("hits the documented route for every call", async () => {
    const { impl, calls } = recorder(() => ok({}));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    await client.getPolicy();
    await client.getRule("deny-delete");
    await client.createRule({ name: "New", match: {}, action: { type: "allow" } });
    await client.updateRule("deny-delete", { enabled: false });
    await client.deleteRule("deny-delete");
    await client.reorderRules(["a", "b"]);
    await client.setDefaultAction("deny");
    await client.queryLogs({ tool: "export_records", limit: 50 });
    await client.getLog("call-1");
    await client.getStats({ since: "2026-08-29T00:00:00.000Z" });

    expect(calls.map((call) => `${call.method} ${call.url.replace(BASE, "")}`)).toEqual([
      "GET /policies",
      "GET /policies/deny-delete",
      "POST /policies",
      "PUT /policies/deny-delete",
      "DELETE /policies/deny-delete",
      "POST /policies/reorder",
      "PUT /policies",
      "GET /logs?tool=export_records&limit=50",
      "GET /logs/call-1",
      "GET /stats?since=2026-08-29T00%3A00%3A00.000Z",
    ]);
  });

  it("sends the reorder and defaultAction bodies the server expects", async () => {
    const { impl, calls } = recorder(() => ok({}));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    await client.reorderRules(["r2", "r1"]);
    await client.setDefaultAction("deny");
    await client.updateRule("r1", { enabled: false });

    expect(calls[0].body).toEqual({ version: WIRE_VERSION, payload: { ids: ["r2", "r1"] } });
    expect(calls[1].body).toEqual({ version: WIRE_VERSION, payload: { defaultAction: "deny" } });
    expect(calls[2].body).toEqual({ version: WIRE_VERSION, payload: { enabled: false } });
  });

  it("escapes rule ids in the path", async () => {
    const { impl, calls } = recorder(() => ok({}));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    await client.getRule("weird id/../etc");
    expect(calls[0].url).toBe(`${BASE}/policies/weird%20id%2F..%2Fetc`);
  });

  it("records a reveal as an admin action", async () => {
    const { impl, calls } = recorder(() => ok({ revealed: true }));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    await expect(client.revealLog("call-1")).resolves.toEqual({ logged: true });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/tokens/reveal`);
    expect(calls[0].body).toEqual({ version: WIRE_VERSION, payload: { logId: "call-1" } });
  });

  it("treats a not_found from /tokens/reveal as non-fatal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = recorder(() => fail("not_found", 404));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    const result = await client.revealLog("call-1");

    expect(result.logged).toBe(false);
    expect(result.reason).toContain("/tokens/reveal");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never throws out of revealLog, even on an unexpected failure", async () => {
    const { impl } = recorder(() => fail("internal_error", 500));
    const client = createGuardClient({ baseUrl: BASE, token: "t", fetchImpl: impl });

    await expect(client.revealLog("call-1")).resolves.toMatchObject({ logged: false });
  });

  it("still bounces the session when the reveal is unauthorized", async () => {
    const onUnauthorized = vi.fn();
    const { impl } = recorder(() => fail("unauthorized", 401));
    const client = createGuardClient({
      baseUrl: BASE,
      token: "t",
      fetchImpl: impl,
      onUnauthorized,
    });

    await expect(client.revealLog("call-1")).resolves.toMatchObject({ logged: false });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
