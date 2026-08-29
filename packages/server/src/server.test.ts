import {
  type GateResponse,
  type GuardStats,
  type GuardStorage,
  type LogPage,
  type LogRecord,
  type PolicyDocument,
  type Rule,
  type TransformResponse,
} from "@webmcp-guard/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The server package is written against the `GuardStorage` interface and
// deliberately does not depend on an adapter. Tests reach for the reference
// in-memory adapter by path rather than adding a dependency edge that would
// only ever be used by tests.
import { memoryStorage, type MemoryStorage } from "../../storage-memory/src/index";

import { DEFAULT_POLICY_RULES } from "./seed";
import { createGuardServer, type GuardServer, type GuardServerConfig } from "./server";

const ADMIN_TOKEN = "test-admin-token-9f2c";
const BASE = "https://portal.test/api/guard";
const APP = "lakeside-portal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SendOptions {
  /** Wrapped in the `{ version, payload }` envelope. */
  payload?: unknown;
  /** Raw body, for malformed-envelope tests. */
  body?: string;
  token?: string;
  query?: Record<string, string>;
  origin?: string;
}

function buildUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function send(
  guard: GuardServer,
  method: string,
  path: string,
  options: SendOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers.origin = options.origin;

  let body: string | undefined;
  if (options.body !== undefined) body = options.body;
  else if (options.payload !== undefined)
    body = JSON.stringify({ version: 1, payload: options.payload });
  if (body !== undefined) headers["content-type"] = "application/json";

  const request = new Request(buildUrl(path, options.query), { method, headers, body });
  return guard.handle(
    request,
    path.split("/").filter((segment) => segment.length > 0),
  );
}

async function payloadOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { version: number; payload: T };
  expect(body.version).toBe(1);
  return body.payload;
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as {
    version: number;
    error: { code: string; message: string };
  };
  expect(body.version).toBe(1);
  return body.error;
}

function config(storage: GuardStorage, overrides: Partial<GuardServerConfig> = {}) {
  return {
    storage,
    orgSecret: "org-secret",
    vaultKey: "vault-key",
    adminToken: ADMIN_TOKEN,
    ...overrides,
  } satisfies GuardServerConfig;
}

let storage: MemoryStorage;
let guard: GuardServer;

beforeEach(async () => {
  storage = memoryStorage();
  guard = createGuardServer(config(storage));
  await guard.ready();
});

function gatePayload(overrides: Record<string, unknown> = {}) {
  return {
    app: APP,
    tool: "search_patients",
    args: { query: "hypertension" },
    toolTags: ["read", "phi"],
    ...overrides,
  };
}

describe("createGuardServer — construction", () => {
  it.each([
    ["orgSecret", "GUARD_ORG_SECRET"],
    ["vaultKey", "GUARD_VAULT_KEY"],
    ["adminToken", "GUARD_ADMIN_TOKEN"],
  ])("refuses to start without %s", (field, envVar) => {
    expect(() => createGuardServer(config(memoryStorage(), { [field]: "" }))).toThrow(envVar);
    expect(() => createGuardServer(config(memoryStorage(), { [field]: "   " }))).toThrow(TypeError);
    expect(() =>
      createGuardServer(config(memoryStorage(), { [field]: undefined as unknown as string })),
    ).toThrow(TypeError);
  });

  it("requires a storage adapter", () => {
    expect(() =>
      createGuardServer({
        storage: undefined as unknown as GuardStorage,
        orgSecret: "a",
        vaultKey: "b",
        adminToken: "c",
      }),
    ).toThrow(/storage/);
  });
});

describe("seeding", () => {
  it("seeds the default policy exactly once, however often it is initialised", async () => {
    await guard.ready();
    await guard.ready();
    expect(await storage.listRules()).toHaveLength(DEFAULT_POLICY_RULES.length);

    // A second server over the same store (a restart, or a second worker).
    const second = createGuardServer(config(storage));
    await second.ready();
    expect(await storage.listRules()).toHaveLength(DEFAULT_POLICY_RULES.length);
  });

  it("initialises lazily on the first request too", async () => {
    const fresh = memoryStorage();
    const lazy = createGuardServer(config(fresh));
    expect(await fresh.listRules()).toHaveLength(0);

    await send(lazy, "POST", "gate", { payload: gatePayload() });
    expect(await fresh.listRules()).toHaveLength(DEFAULT_POLICY_RULES.length);
  });

  it("can be turned off for a host app that owns its policy", async () => {
    const fresh = memoryStorage();
    const unseeded = createGuardServer(config(fresh, { seed: false }));
    await unseeded.ready();
    expect(await fresh.listRules()).toHaveLength(0);
  });
});

describe("POST /gate", () => {
  it("allows a call, echoes the args back and logs a pending entry", async () => {
    const response = await send(guard, "POST", "gate", { payload: gatePayload() });
    expect(response.status).toBe(200);

    const gate = await payloadOf<GateResponse>(response);
    expect(gate.callId).toMatch(UUID);
    expect(gate.verdict).toBe("allow");
    expect(gate.args).toEqual({ query: "hypertension" });
    expect(gate.message).toBeUndefined();
    // The transform aspect matched; the gate aspect fell through to the baseline.
    expect(gate.ruleIds).toEqual(["phi-transform-default"]);

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      id: gate.callId,
      status: "pending",
      app: APP,
      tool: "search_patients",
      verdict: "allow",
      ruleIds: ["phi-transform-default"],
      durationMs: 0,
      dataClasses: [],
      payloads: {
        argsBefore: { query: "hypertension" },
        argsAfter: { query: "hypertension" },
      },
    });
    expect(entry?.message).toBeUndefined();
  });

  it("denies delete_patient with the seeded message and logs a completed entry", async () => {
    const response = await send(guard, "POST", "gate", {
      payload: gatePayload({
        tool: "delete_patient",
        args: { mrn: "LM-100060" },
        toolTags: ["write", "destructive"],
      }),
    });

    const gate = await payloadOf<GateResponse>(response);
    const rule = DEFAULT_POLICY_RULES[3];
    if (rule.action.type !== "deny") throw new Error("expected a deny rule");

    expect(response.status).toBe(200);
    expect(gate.verdict).toBe("deny");
    expect(gate.args).toBeUndefined();
    expect(gate.ruleIds).toEqual(["delete-patient-deny-temp"]);
    expect(gate.message).toBe(
      `Blocked by policy ${rule.name} (delete-patient-deny-temp): ${rule.action.message}`,
    );

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      status: "complete",
      verdict: "deny",
      message: gate.message,
      payloads: { argsBefore: { mrn: "LM-100060" } },
    });
  });

  it("asks for a justification when that rule is enabled", async () => {
    await storage.updateRule("export-requires-justification", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "export_patients",
          args: {},
          toolTags: ["read", "phi", "bulk"],
        }),
      }),
    );

    expect(gate.verdict).toBe("require-justification");
    expect(gate.message).toContain(
      "Justification required by policy Export requires justification",
    );
    expect(gate.message).toContain("40 characters");
    expect(gate.args).toBeUndefined();
    // The PHI transform rule matched too, so both ids are reported.
    expect(gate.ruleIds).toEqual(["phi-transform-default", "export-requires-justification"]);

    const entry = await storage.getLog(gate.callId);
    expect(entry?.status).toBe("complete");
    expect(entry?.verdict).toBe("require-justification");
  });

  it("asks for human confirmation when the destructive rule is enabled, ahead of the temp deny", async () => {
    await storage.updateRule("destructive-requires-confirmation", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "delete_patient",
          args: {},
          toolTags: ["write", "destructive"],
        }),
      }),
    );

    // Priority 30 beats the temporary deny rule at priority 40.
    expect(gate.verdict).toBe("require-confirmation");
    expect(gate.ruleIds).toEqual(["destructive-requires-confirmation"]);
    expect(gate.message).toContain("Human confirmation required by policy");
    expect(gate.message).toContain("ask the person using this page to approve it");
  });

  it("falls back to the document default action", async () => {
    for (const rule of await storage.listRules()) await storage.deleteRule(rule.id);
    await storage.setDefaultAction("deny");

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );

    expect(gate.verdict).toBe("deny");
    expect(gate.ruleIds).toEqual([]);
    expect(gate.message).toContain("Blocked by the default policy");
    expect(gate.message).toContain("search_patients");
  });

  it("matches role-scoped rules from the session context", async () => {
    await storage.createRule({
      id: "billing-no-export",
      name: "Billing cannot export",
      priority: 5,
      match: { roles: ["billing"], tools: ["export_patients"] },
      action: { type: "deny", message: "Billing staff cannot export patient records." },
    });

    const denied = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "export_patients",
          args: {},
          toolTags: ["read"],
          sessionContext: { userId: "u-3", role: "billing" },
        }),
      }),
    );
    expect(denied.verdict).toBe("deny");

    const allowed = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "export_patients",
          args: {},
          toolTags: ["read"],
          sessionContext: { userId: "u-1", role: "clinician" },
        }),
      }),
    );
    expect(allowed.verdict).toBe("allow");
  });

  it("records the posture snapshot and session on the log entry", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          posture: {
            brands: [
              { brand: "Not/A)Brand", version: "8" },
              { brand: "Chromium", version: "149" },
            ],
            platform: "macOS",
            isSecureContext: true,
            agentId: "chatgpt-atlas",
            timestamp: "2026-08-29T12:00:00.000Z",
          },
          sessionContext: { userId: "u-1", role: "clinician" },
        }),
      }),
    );

    expect(await storage.getLog(gate.callId)).toMatchObject({
      agent: {
        agentId: "chatgpt-atlas",
        browserBrand: "Chromium",
        browserVersion: "149",
        platform: "macOS",
        isSecureContext: true,
      },
      session: { userId: "u-1", role: "clinician" },
    });
  });

  it("issues a distinct callId per call", async () => {
    const first = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    const second = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );

    expect(first.callId).not.toBe(second.callId);
    expect((await storage.queryLogs()).total).toBe(2);
  });

  describe("wire validation", () => {
    it.each([
      ["a body that is not JSON", { body: "not json" }],
      ["a bare payload with no envelope", { body: JSON.stringify(gatePayload()) }],
      ["the wrong wire version", { body: JSON.stringify({ version: 2, payload: gatePayload() }) }],
      [
        "extra envelope keys",
        { body: JSON.stringify({ version: 1, payload: gatePayload(), extra: 1 }) },
      ],
      ["a missing tool", { payload: { app: APP, args: {} } }],
      ["a non-object args value", { payload: { app: APP, tool: "t", args: "nope" } }],
      ["an unknown payload field", { payload: { ...gatePayload(), sneaky: true } }],
    ])("rejects %s with 400", async (_label, options: SendOptions) => {
      const response = await send(guard, "POST", "gate", options);
      expect(response.status).toBe(400);

      const error = await errorOf(response);
      expect(error.code).toBe("bad_request");
      expect(error.message.length).toBeGreaterThan(10);
      expect((await storage.queryLogs()).total).toBe(0);
    });

    it("names the offending field so an agent can fix its call", async () => {
      const error = await errorOf(
        await send(guard, "POST", "gate", { payload: { app: APP, args: {} } }),
      );
      expect(error.message).toContain("payload.tool");
    });
  });

  it("rejects other methods with 405 and an Allow header", async () => {
    const response = await send(guard, "GET", "gate");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("POST /transform", () => {
  async function gateAllow(overrides: Record<string, unknown> = {}): Promise<GateResponse> {
    return payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload(overrides) }),
    );
  }

  it("completes the pending entry and returns the result unchanged", async () => {
    const gate = await gateAllow();

    const response = await send(guard, "POST", "transform", {
      payload: {
        app: APP,
        tool: "search_patients",
        callId: gate.callId,
        result: { patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] },
      },
    });

    const transform = await payloadOf<TransformResponse>(response);
    expect(response.status).toBe(200);
    expect(transform.result).toEqual({ patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] });
    expect(transform.classesFound).toEqual([]);
    // Only the transform-aspect rule is reported back on this half.
    expect(transform.ruleIds).toEqual(["phi-transform-default"]);

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      status: "complete",
      verdict: "allow",
      payloads: {
        argsBefore: { query: "hypertension" },
        resultBefore: { patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] },
        resultAfter: { patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] },
      },
    });
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect((await storage.queryLogs()).total).toBe(1);
  });

  it("reports no transform rules when none matched at the gate", async () => {
    const gate = await gateAllow({ tool: "list_appointments", toolTags: ["read"] });

    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: { app: APP, tool: "list_appointments", callId: gate.callId, result: [] },
      }),
    );

    expect(transform.ruleIds).toEqual([]);
  });

  it("logs a standalone entry for an unknown callId instead of failing", async () => {
    const response = await send(guard, "POST", "transform", {
      payload: {
        app: APP,
        tool: "search_patients",
        callId: "00000000-0000-4000-8000-000000000000",
        result: { ok: true },
      },
    });

    expect(response.status).toBe(200);
    expect((await payloadOf<TransformResponse>(response)).result).toEqual({ ok: true });

    const page = await storage.queryLogs();
    expect(page.total).toBe(1);
    expect(page.entries[0]).toMatchObject({
      status: "complete",
      tool: "search_patients",
      payloads: { resultBefore: { ok: true } },
    });
    expect(page.entries[0].id).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(page.entries[0].message).toContain("without a matching pending gate call");
    expect(page.entries[0].message).toContain("00000000-0000-4000-8000-000000000000");
  });

  it("logs a standalone entry when no callId is supplied at all", async () => {
    await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "search_patients", result: { ok: true } },
    });

    const page = await storage.queryLogs();
    expect(page.total).toBe(1);
    expect(page.entries[0].message).toContain("without a matching pending gate call");
    expect(page.entries[0].message).not.toContain("callId");
  });

  it("cannot be replayed to rewrite a closed audit record", async () => {
    const gate = await gateAllow();
    await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "search_patients", callId: gate.callId, result: { first: true } },
    });

    const replay = await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "search_patients", callId: gate.callId, result: { second: true } },
    });

    expect(replay.status).toBe(200);
    const original = await storage.getLog(gate.callId);
    expect(original?.payloads.resultBefore).toEqual({ first: true });
    // The replay was recorded separately rather than overwriting the original.
    expect((await storage.queryLogs()).total).toBe(2);
  });

  it("refuses to complete an entry belonging to a different tool", async () => {
    const gate = await gateAllow();

    await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "export_patients", callId: gate.callId, result: { csv: "…" } },
    });

    expect(await storage.getLog(gate.callId)).toMatchObject({ status: "pending" });
    expect((await storage.queryLogs()).total).toBe(2);
  });

  it("refuses to complete an entry belonging to a different app", async () => {
    const gate = await gateAllow();

    await send(guard, "POST", "transform", {
      payload: { app: "other-app", tool: "search_patients", callId: gate.callId, result: {} },
    });

    expect(await storage.getLog(gate.callId)).toMatchObject({ status: "pending" });
  });

  it("rejects a malformed body with 400", async () => {
    const response = await send(guard, "POST", "transform", { payload: { app: APP } });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("bad_request");
  });
});

describe("admin authentication", () => {
  it.each(["policies", "logs", "stats"])("rejects an unauthenticated %s request", async (path) => {
    const response = await send(guard, "GET", path);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthorized");
  });

  it("gives the same answer for a missing and a wrong token", async () => {
    const missing = await errorOf(await send(guard, "GET", "logs"));
    const wrong = await errorOf(await send(guard, "GET", "logs", { token: "not-the-token" }));
    const almost = await errorOf(
      await send(guard, "GET", "logs", { token: ADMIN_TOKEN.slice(0, -1) }),
    );

    expect(wrong).toEqual(missing);
    expect(almost).toEqual(missing);
    expect(missing.message).not.toContain(ADMIN_TOKEN);
  });

  it("accepts the configured token", async () => {
    expect((await send(guard, "GET", "policies", { token: ADMIN_TOKEN })).status).toBe(200);
    expect((await send(guard, "GET", "logs", { token: ADMIN_TOKEN })).status).toBe(200);
    expect((await send(guard, "GET", "stats", { token: ADMIN_TOKEN })).status).toBe(200);
  });

  it("does not leak the policy through a mutating route either", async () => {
    const response = await send(guard, "DELETE", "policies/phi-transform-default");
    expect(response.status).toBe(401);
    expect(await storage.getRule("phi-transform-default")).not.toBeNull();
  });
});

describe("/policies", () => {
  const token = ADMIN_TOKEN;

  it("returns the ordered document", async () => {
    const document = await payloadOf<PolicyDocument>(
      await send(guard, "GET", "policies", { token }),
    );

    expect(document.version).toBe(1);
    expect(document.defaultAction).toBe("allow");
    expect(document.rules.map((rule) => rule.id)).toEqual(DEFAULT_POLICY_RULES.map((r) => r.id));
  });

  it("creates a rule", async () => {
    const response = await send(guard, "POST", "policies", {
      token,
      payload: {
        name: "Block bulk exports",
        match: { tools: ["export_patients"] },
        action: { type: "deny", message: "Exports are disabled during the audit." },
      },
    });

    expect(response.status).toBe(201);
    const rule = await payloadOf<Rule>(response);
    expect(rule.id).toBe("block-bulk-exports");
    expect(rule.enabled).toBe(true);
    expect(await storage.getRule(rule.id)).not.toBeNull();
  });

  it("accepts a partial transform matrix and fills in passthrough", async () => {
    const rule = await payloadOf<Rule>(
      await send(guard, "POST", "policies", {
        token,
        payload: {
          name: "Mask credit cards",
          match: {},
          action: { type: "transform", perClass: { credit_card: "mask" } },
        },
      }),
    );

    if (rule.action.type !== "transform") throw new Error("expected a transform rule");
    expect(rule.action.perClass.credit_card).toBe("mask");
    expect(rule.action.perClass.ssn).toBe("passthrough");
  });

  it("rejects a duplicate id with 409 and a reserved id with 400", async () => {
    const duplicate = await send(guard, "POST", "policies", {
      token,
      payload: { id: "phi-transform-default", name: "Clash", match: {}, action: { type: "allow" } },
    });
    expect(duplicate.status).toBe(409);
    expect((await errorOf(duplicate)).code).toBe("conflict");

    const reserved = await send(guard, "POST", "policies", {
      token,
      payload: { id: "reorder", name: "Reserved", match: {}, action: { type: "allow" } },
    });
    expect(reserved.status).toBe(400);
  });

  it.each([
    ["an unknown action type", { name: "x", match: {}, action: { type: "teleport" } }],
    ["a deny rule with no message", { name: "x", match: {}, action: { type: "deny" } }],
    [
      "an unknown matcher",
      { name: "x", match: { browsers: ["chrome"] }, action: { type: "allow" } },
    ],
    ["an empty name", { name: "", match: {}, action: { type: "allow" } }],
    ["an id with a slash", { id: "a/b", name: "x", match: {}, action: { type: "allow" } }],
  ])("rejects %s", async (_label, payload) => {
    const response = await send(guard, "POST", "policies", { token, payload });
    expect(response.status).toBe(400);
  });

  it("updates, enables and disables a rule", async () => {
    const updated = await payloadOf<Rule>(
      await send(guard, "PUT", "policies/export-requires-justification", {
        token,
        payload: { enabled: true },
      }),
    );

    expect(updated.enabled).toBe(true);
    expect(updated.name).toBe("Export requires justification");

    const renamed = await payloadOf<Rule>(
      await send(guard, "PUT", "policies/export-requires-justification", {
        token,
        payload: { name: "Export needs a reason", priority: 15 },
      }),
    );
    expect(renamed).toMatchObject({ name: "Export needs a reason", priority: 15, enabled: true });
  });

  it("404s on an unknown rule and 400s on an empty patch", async () => {
    const unknown = await send(guard, "PUT", "policies/nope", {
      token,
      payload: { enabled: true },
    });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");

    const empty = await send(guard, "PUT", "policies/phi-transform-default", {
      token,
      payload: {},
    });
    expect(empty.status).toBe(400);
  });

  it("reads a single rule", async () => {
    const rule = await payloadOf<Rule>(
      await send(guard, "GET", "policies/phi-transform-default", { token }),
    );
    expect(rule.name).toBe("Tokenize PHI on phi-tagged tools");

    expect((await send(guard, "GET", "policies/nope", { token })).status).toBe(404);
  });

  it("deletes a rule once", async () => {
    const first = await send(guard, "DELETE", "policies/delete-patient-deny-temp", { token });
    expect(first.status).toBe(200);
    expect(await payloadOf(first)).toEqual({ id: "delete-patient-deny-temp", deleted: true });

    const second = await send(guard, "DELETE", "policies/delete-patient-deny-temp", { token });
    expect(second.status).toBe(404);
  });

  it("reorders rules and reports the new order", async () => {
    const document = await payloadOf<PolicyDocument>(
      await send(guard, "POST", "policies/reorder", {
        token,
        payload: { ids: ["delete-patient-deny-temp", "phi-transform-default"] },
      }),
    );

    expect(document.rules.map((rule) => rule.id).slice(0, 2)).toEqual([
      "delete-patient-deny-temp",
      "phi-transform-default",
    ]);
  });

  it("rejects a reorder that names an unknown rule", async () => {
    const response = await send(guard, "POST", "policies/reorder", {
      token,
      payload: { ids: ["phi-transform-default", "ghost-rule"] },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("ghost-rule");
  });

  it("sets the document default action", async () => {
    const document = await payloadOf<PolicyDocument>(
      await send(guard, "PUT", "policies", { token, payload: { defaultAction: "deny" } }),
    );

    expect(document.defaultAction).toBe("deny");
    expect(await storage.getDefaultAction()).toBe("deny");
  });

  it("takes effect on the next gate call, with no restart", async () => {
    await send(guard, "PUT", "policies/delete-patient-deny-temp", {
      token,
      payload: { enabled: false },
    });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "delete_patient",
          args: {},
          toolTags: ["write", "destructive"],
        }),
      }),
    );

    expect(gate.verdict).toBe("allow");
  });

  it("405s on an unsupported method", async () => {
    const response = await send(guard, "DELETE", "policies", { token });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });
});

describe("/logs", () => {
  const token = ADMIN_TOKEN;

  beforeEach(async () => {
    await send(guard, "POST", "gate", { payload: gatePayload() });
    await send(guard, "POST", "gate", {
      payload: gatePayload({ tool: "get_patient", args: { mrn: "LM-1" } }),
    });
    await send(guard, "POST", "gate", {
      payload: gatePayload({ tool: "delete_patient", args: {}, toolTags: ["destructive"] }),
    });
  });

  it("returns entries newest first with a total", async () => {
    const page = await payloadOf<LogPage>(await send(guard, "GET", "logs", { token }));

    expect(page.total).toBe(3);
    expect(page.entries.map((entry) => entry.tool)).toEqual([
      "delete_patient",
      "get_patient",
      "search_patients",
    ]);
  });

  it("filters by tool and verdict", async () => {
    const byTool = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", { token, query: { tool: "get_patient" } }),
    );
    expect(byTool.total).toBe(1);

    const denied = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", { token, query: { verdict: "deny" } }),
    );
    expect(denied.entries.map((entry) => entry.tool)).toEqual(["delete_patient"]);
  });

  it("paginates with limit and cursor", async () => {
    const first = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", { token, query: { limit: "2" } }),
    );
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", {
        token,
        query: { limit: "2", cursor: first.nextCursor as string },
      }),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it("ignores unknown query parameters", async () => {
    const page = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", { token, query: { _: "1756480000000" } }),
    );
    expect(page.total).toBe(3);
  });

  it("rejects an invalid filter value", async () => {
    const response = await send(guard, "GET", "logs", { token, query: { verdict: "maybe" } });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("verdict");

    expect(
      (await send(guard, "GET", "logs", { token, query: { since: "yesterday" } })).status,
    ).toBe(400);
    expect((await send(guard, "GET", "logs", { token, query: { limit: "-1" } })).status).toBe(400);
  });

  it("returns one entry by id, or 404", async () => {
    const page = await payloadOf<LogPage>(await send(guard, "GET", "logs", { token }));
    const wanted = page.entries[0];

    const entry = await payloadOf<LogRecord>(
      await send(guard, "GET", `logs/${wanted.id}`, { token }),
    );
    expect(entry.id).toBe(wanted.id);
    expect(entry.payloads).toBeDefined();

    expect((await send(guard, "GET", "logs/does-not-exist", { token })).status).toBe(404);
  });
});

describe("/stats", () => {
  it("counts calls, denials and tools", async () => {
    await send(guard, "POST", "gate", { payload: gatePayload() });
    await send(guard, "POST", "gate", { payload: gatePayload() });
    await send(guard, "POST", "gate", {
      payload: gatePayload({ tool: "delete_patient", args: {}, toolTags: ["destructive"] }),
    });

    const stats = await payloadOf<GuardStats>(
      await send(guard, "GET", "stats", { token: ADMIN_TOKEN }),
    );

    expect(stats.totalCalls).toBe(3);
    expect(stats.denied).toBe(1);
    expect(stats.transformed).toBe(0);
    expect(stats.byTool[0]).toEqual({ tool: "search_patients", count: 2 });
    expect(stats.byDay).toHaveLength(1);
  });

  it("honours a range and rejects a bad one", async () => {
    await send(guard, "POST", "gate", { payload: gatePayload() });

    const empty = await payloadOf<GuardStats>(
      await send(guard, "GET", "stats", {
        token: ADMIN_TOKEN,
        query: { since: "2027-01-01T00:00:00.000Z" },
      }),
    );
    expect(empty.totalCalls).toBe(0);

    expect(
      (await send(guard, "GET", "stats", { token: ADMIN_TOKEN, query: { until: "soon" } })).status,
    ).toBe(400);
  });
});

describe("routing", () => {
  it("404s unknown paths", async () => {
    expect((await send(guard, "POST", "nope", { payload: {} })).status).toBe(404);
    expect((await send(guard, "POST", "gate/extra", { payload: {} })).status).toBe(404);
    expect((await send(guard, "GET", "policies/a/b/c", { token: ADMIN_TOKEN })).status).toBe(404);
    expect((await send(guard, "GET", "", {})).status).toBe(404);
  });

  it("never leaks internals when something breaks", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: GuardStorage = {
      ...memoryStorage(),
      getPolicy: async () => {
        throw new Error("connection failed for user secret-user@db.internal");
      },
    };
    const brittle = createGuardServer(config(broken));

    const response = await send(brittle, "POST", "gate", { payload: gatePayload() });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret-user");
    expect(text).toContain("internal_error");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("CORS", () => {
  it("sends no CORS headers when no console origin is configured", async () => {
    const response = await send(guard, "GET", "logs", {
      token: ADMIN_TOKEN,
      origin: "https://console.test",
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a preflight from the configured console origin only", async () => {
    const cors = createGuardServer(config(storage, { consoleOrigin: "https://console.test" }));

    const allowed = await send(cors, "OPTIONS", "logs", { origin: "https://console.test" });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://console.test");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const other = await send(cors, "OPTIONS", "logs", { origin: "https://evil.test" });
    expect(other.status).toBe(204);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(other.headers.get("vary")).toBe("Origin");
  });

  it("echoes the console origin on real admin responses, never a wildcard", async () => {
    const cors = createGuardServer(config(storage, { consoleOrigin: "https://console.test" }));

    const response = await send(cors, "GET", "logs", {
      token: ADMIN_TOKEN,
      origin: "https://console.test",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://console.test");

    const unauthorized = await send(cors, "GET", "logs", { origin: "https://console.test" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe("https://console.test");
  });
});

describe("nextHandler", () => {
  it("reads catch-all params delivered as a promise (Next 15)", async () => {
    const { POST } = guard.nextHandler();

    const response = await POST(
      new Request(`${BASE}/gate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, payload: gatePayload() }),
      }),
      { params: Promise.resolve({ route: ["gate"] }) },
    );

    expect(response.status).toBe(200);
    expect((await payloadOf<GateResponse>(response)).verdict).toBe("allow");
  });

  it("also accepts plain params and a differently named catch-all", async () => {
    const { GET } = guard.nextHandler();

    const plain = await GET(new Request(`${BASE}/logs`), { params: { route: ["logs"] } });
    expect(plain.status).toBe(401);

    const renamed = await GET(new Request(`${BASE}/logs`), { params: { path: ["logs"] } });
    expect(renamed.status).toBe(401);
  });

  it("404s when no params are supplied at all", async () => {
    const { GET } = guard.nextHandler();
    expect((await GET(new Request(`${BASE}/logs`))).status).toBe(404);
  });

  it("exposes every verb the routing table uses", () => {
    const handlers = guard.nextHandler();
    expect(Object.keys(handlers).sort()).toEqual(["DELETE", "GET", "OPTIONS", "POST", "PUT"]);
  });
});
