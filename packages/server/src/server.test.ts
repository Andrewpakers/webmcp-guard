import {
  PerClassTransformSchema,
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

import { CONFIRMATION_TTL_MS, hashCallArgs } from "./confirmation";
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
  /** Extra request headers — a cookie, for the session-resolver tests. */
  headers?: Record<string, string>;
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
  const headers: Record<string, string> = { ...options.headers };
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

/**
 * Runs one `search_patients` call end to end so its result is tokenized and the
 * vault has something in it — the only way to get a real token to feed back in.
 */
async function searchAndTransform(result: unknown): Promise<TransformResponse> {
  const gate = await payloadOf<GateResponse>(
    await send(guard, "POST", "gate", { payload: gatePayload() }),
  );
  return payloadOf<TransformResponse>(
    await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "search_patients", callId: gate.callId, result },
    }),
  );
}

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

  it("denies with the rule's own message and logs a completed entry", async () => {
    await storage.createRule({
      id: "no-deletes",
      name: "Deleting patients from an agent is blocked",
      priority: 1,
      match: { tools: ["delete_patient"] },
      action: {
        type: "deny",
        message: "Ask the person using this page to delete the record in the portal.",
      },
    });

    const response = await send(guard, "POST", "gate", {
      payload: gatePayload({
        tool: "delete_patient",
        args: { mrn: "LM-100060" },
        toolTags: ["write", "destructive"],
      }),
    });

    const gate = await payloadOf<GateResponse>(response);

    expect(response.status).toBe(200);
    expect(gate.verdict).toBe("deny");
    expect(gate.args).toBeUndefined();
    expect(gate.ruleIds).toEqual(["no-deletes"]);
    expect(gate.message).toBe(
      "Blocked by policy Deleting patients from an agent is blocked (no-deletes): " +
        "Ask the person using this page to delete the record in the portal.",
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
    // This test is about the `roles` matcher, so the seeded justification rule
    // (which also matches export_patients) is taken out of the way.
    await storage.updateRule("export-requires-justification", { enabled: false });
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

/**
 * `GuardServerConfig.resolveSession` — the honest half of role-scoped policy
 * (`docs/07` Phase 6).
 *
 * `GateRequest.sessionContext` is a claim the page makes. These tests hold the
 * gate to the rule that makes role rules worth having: when the host app can
 * answer "who is this", its answer is what policy matches and what the log
 * records, and the page's claim never overrides it.
 */
describe("POST /gate — server-resolved session", () => {
  /** A rule that only fires for billing, so the resolved role is observable. */
  async function seedBillingRule(): Promise<void> {
    await storage.createRule({
      id: "billing-no-export",
      name: "Billing cannot export",
      priority: 5,
      match: { roles: ["billing"], tools: ["export_patients"] },
      action: { type: "deny", message: "Billing staff cannot export patient records." },
    });
    // The seeded justification rule also matches export_patients; disabling it
    // keeps the verdict a clean read of the role matcher.
    await storage.updateRule("export-requires-justification", { enabled: false });
  }

  const exportPayload = (overrides: Record<string, unknown> = {}) =>
    gatePayload({ tool: "export_patients", args: {}, toolTags: ["read"], ...overrides });

  function withResolver(resolveSession: GuardServerConfig["resolveSession"]): GuardServer {
    return createGuardServer(config(storage, { resolveSession }));
  }

  it("uses the resolver's answer for policy, over a spoofed client claim", async () => {
    await seedBillingRule();
    const resolved = withResolver(() => ({ userId: "sam-levin", role: "billing" }));

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        // The page claims to be a physician. It is holding billing's cookie.
        payload: exportPayload({ sessionContext: { userId: "dr-reyes", role: "physician" } }),
      }),
    );

    expect(gate.verdict).toBe("deny");
    expect(gate.ruleIds).toEqual(["billing-no-export"]);
  });

  it("records the resolved identity — not the claim — on the audit entry", async () => {
    const resolved = withResolver(() => ({ userId: "sam-levin", role: "billing" }));

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: gatePayload({ sessionContext: { userId: "dr-reyes", role: "physician" } }),
      }),
    );

    const entry = await storage.getLog(gate.callId);
    expect(entry?.session).toEqual({ userId: "sam-levin", role: "billing" });
    // The disagreement is written down rather than quietly discarded.
    expect(entry?.message).toContain("The page claimed userId=dr-reyes role=physician");
    expect(entry?.message).toContain("resolved userId=sam-levin role=billing");
    expect(entry?.message).toContain("The resolved identity decided this call");
  });

  it("says nothing about a claim that agrees with the resolver", async () => {
    const resolved = withResolver(() => ({ userId: "sam-levin", role: "billing" }));

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: gatePayload({ sessionContext: { userId: "sam-levin", role: "billing" } }),
      }),
    );

    const entry = await storage.getLog(gate.callId);
    expect(entry?.session).toEqual({ userId: "sam-levin", role: "billing" });
    expect(entry?.message).toBeUndefined();
  });

  it("reads the request, so a host can resolve from a cookie or a header", async () => {
    await seedBillingRule();
    const resolved = withResolver((request) =>
      request.headers.get("cookie")?.includes("role=billing") === true
        ? { userId: "sam-levin", role: "billing" }
        : { userId: "dr-reyes", role: "physician" },
    );

    const denied = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: exportPayload(),
        headers: { cookie: "role=billing" },
      }),
    );
    expect(denied.verdict).toBe("deny");

    const allowed = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", { payload: exportPayload() }),
    );
    expect(allowed.verdict).toBe("allow");
  });

  it("awaits an async resolver", async () => {
    const resolved = withResolver(async () =>
      Promise.resolve({ userId: "nurse-okafor", role: "nursing" }),
    );

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", { payload: gatePayload() }),
    );
    expect((await storage.getLog(gate.callId))?.session).toEqual({
      userId: "nurse-okafor",
      role: "nursing",
    });
  });

  it("keeps the client's claim when the resolver declines to answer", async () => {
    await seedBillingRule();
    const resolved = withResolver(() => undefined);

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: exportPayload({ sessionContext: { userId: "u-3", role: "billing" } }),
      }),
    );

    // `undefined` is an answer: "this host has no session of its own here".
    expect(gate.verdict).toBe("deny");
    expect((await storage.getLog(gate.callId))?.session).toEqual({
      userId: "u-3",
      role: "billing",
    });
  });

  it("records no identity at all when the resolver throws", async () => {
    await seedBillingRule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = withResolver(() => {
      throw new Error("session store is down");
    });

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: exportPayload({ sessionContext: { userId: "u-3", role: "billing" } }),
      }),
    );

    // A resolver failure is not permission to believe the page instead, so the
    // role-scoped deny does not fire off the claimed role.
    expect(gate.verdict).toBe("allow");
    const entry = await storage.getLog(gate.callId);
    expect(entry?.session).toBeUndefined();
    expect(entry?.message).toContain("session resolver failed");
    expect(entry?.message).toContain("was not used in its place");
    expect(warn).toHaveBeenCalled();
  });

  it("records no identity when the resolver answers with something else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = withResolver(() => "sam-levin" as unknown as { userId: string; role: string });

    const gate = await payloadOf<GateResponse>(
      await send(resolved, "POST", "gate", {
        payload: gatePayload({ sessionContext: { userId: "u-3", role: "billing" } }),
      }),
    );

    const entry = await storage.getLog(gate.callId);
    expect(entry?.session).toBeUndefined();
    expect(entry?.message).toContain("not a session context");
    expect(warn).toHaveBeenCalled();
  });

  it("leaves the Phase 5 behaviour alone when no resolver is configured", async () => {
    await seedBillingRule();
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: exportPayload({ sessionContext: { userId: "u-3", role: "billing" } }),
      }),
    );

    expect(gate.verdict).toBe("deny");
    expect((await storage.getLog(gate.callId))?.session).toEqual({
      userId: "u-3",
      role: "billing",
    });
  });

  it("shapes GET /policies/effective for the resolved role", async () => {
    await storage.createRule({
      id: "billing-must-justify",
      name: "Billing must justify a chart read",
      priority: 5,
      match: { roles: ["billing"], tools: ["get_patient"] },
      action: { type: "require-justification", minChars: 25 },
    });

    const billing = withResolver(() => ({ userId: "sam-levin", role: "billing" }));
    const clinician = withResolver(() => ({ userId: "dr-reyes", role: "physician" }));
    const query = { app: APP, tool: "get_patient", tags: "read,phi" };

    expect(
      await payloadOf<{ requiresJustification: boolean; minChars: number | null }>(
        await send(billing, "GET", "policies/effective", { query }),
      ),
    ).toMatchObject({ requiresJustification: true, minChars: 25 });

    expect(
      await payloadOf<{ requiresJustification: boolean }>(
        await send(clinician, "GET", "policies/effective", { query }),
      ),
    ).toMatchObject({ requiresJustification: false });
  });

  it("hands the resolved session to the justification evaluator", async () => {
    const seen: unknown[] = [];
    const resolved = createGuardServer(
      config(storage, {
        resolveSession: () => ({ userId: "sam-levin", role: "billing" }),
        evaluator: {
          evaluate: (input) => {
            seen.push(input.context.session);
            return { verdict: "pass" as const, reason: "fine" };
          },
        },
      }),
    );

    await send(resolved, "POST", "gate", {
      payload: gatePayload({
        tool: "export_patients",
        args: { justification: "Quarterly billing reconciliation for the finance team audit." },
        toolTags: ["read", "phi", "bulk"],
        sessionContext: { userId: "dr-reyes", role: "physician" },
      }),
    });

    expect(seen).toEqual([{ userId: "sam-levin", role: "billing" }]);
  });
});

/**
 * The confirmation flow — the demo's dramatic beat, and the part of Phase 5
 * with the most ways to go wrong. What these tests hold the gate to:
 *
 *  1. asking produces a one-time id bound to *this* call;
 *  2. presenting a valid id runs the call exactly as an allow would;
 *  3. every id is spent on first presentation, valid or not, so nothing is
 *     replayable — including a replay that tampers with the arguments.
 */
describe("POST /gate — human confirmation", () => {
  const deletePayload = (overrides: Record<string, unknown> = {}) =>
    gatePayload({
      tool: "delete_patient",
      args: { patient: "LM-100060" },
      toolTags: ["write", "destructive"],
      ...overrides,
    });

  async function ask(overrides: Record<string, unknown> = {}): Promise<GateResponse> {
    return payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: deletePayload(overrides) }),
    );
  }

  it("mints a one-time id, explains itself, and runs nothing", async () => {
    const gate = await ask();

    expect(gate.verdict).toBe("require-confirmation");
    expect(gate.confirmationId).toMatch(UUID);
    expect(gate.args).toBeUndefined();
    expect(gate.ruleIds).toEqual(["destructive-requires-confirmation"]);
    expect(gate.message).toContain("Human confirmation required by policy");

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      status: "complete",
      verdict: "require-confirmation",
      payloads: { argsBefore: { patient: "LM-100060" } },
    });
  });

  it("binds the id to the call, the tool and the arguments", async () => {
    const gate = await ask();
    const stored = await storage.consumeConfirmation(gate.confirmationId as string);

    expect(stored).toMatchObject({
      app: APP,
      tool: "delete_patient",
      callId: gate.callId,
      argsHash: hashCallArgs(APP, "delete_patient", { patient: "LM-100060" }),
    });
    expect(Date.parse(stored?.expiresAt as string) - Date.parse(stored?.issuedAt as string)).toBe(
      CONFIRMATION_TTL_MS,
    );
  });

  it("issues a different id every time", async () => {
    const first = await ask();
    const second = await ask();
    expect(first.confirmationId).not.toBe(second.confirmationId);
  });

  it("runs the call as an allow once the id comes back", async () => {
    const asked = await ask();
    const approved = await ask({ confirmationId: asked.confirmationId });

    expect(approved.verdict).toBe("allow");
    expect(approved.args).toEqual({ patient: "LM-100060" });
    expect(approved.callId).not.toBe(asked.callId);
    // The rule that demanded the approval still gets the credit in the log.
    expect(approved.ruleIds).toEqual(["destructive-requires-confirmation"]);
    expect(approved.message).toContain("approved this call");

    const entry = await storage.getLog(approved.callId);
    expect(entry).toMatchObject({ status: "pending", verdict: "allow" });
    expect(entry?.message).toContain("Approved in the page by the person using this browser");
    expect(entry?.message).toContain("destructive-requires-confirmation");
  });

  it("refuses a replay of an id that already ran", async () => {
    const asked = await ask();
    await ask({ confirmationId: asked.confirmationId });

    const replayed = await ask({ confirmationId: asked.confirmationId });
    expect(replayed.verdict).toBe("deny");
    expect(replayed.args).toBeUndefined();
    expect(replayed.message).toContain("single-use");

    const entry = await storage.getLog(replayed.callId);
    expect(entry).toMatchObject({ status: "complete", verdict: "deny" });
    expect(entry?.message).toContain("unknown-or-used");
  });

  it("refuses an id that was never issued", async () => {
    const bogus = await ask({ confirmationId: "6f1c7e3a-0000-4000-8000-000000000000" });
    expect(bogus.verdict).toBe("deny");
    expect(bogus.message).toContain("never issued");
  });

  it("refuses arguments that changed after the person approved them", async () => {
    const asked = await ask();

    const tampered = await ask({
      confirmationId: asked.confirmationId,
      args: { patient: "LM-100061" },
    });

    expect(tampered.verdict).toBe("deny");
    expect(tampered.message).toContain("arguments changed");

    // …and the tampered attempt burned the approval, so the original call
    // cannot be re-run afterwards either. This is the anti-replay property:
    // consume first, judge second.
    const honest = await ask({ confirmationId: asked.confirmationId });
    expect(honest.verdict).toBe("deny");
    expect(honest.message).toContain("single-use");
  });

  it("refuses an approval presented for a different tool", async () => {
    // Widen the confirmation rule to cover export too, and take the
    // justification rule (priority 20) out of its way.
    await storage.updateRule("destructive-requires-confirmation", {
      priority: 15,
      match: { tools: { tags: ["destructive", "bulk"] } },
    });
    await storage.updateRule("export-requires-justification", { enabled: false });
    const asked = await ask();

    const elsewhere = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "export_patients",
          args: { patient: "LM-100060" },
          toolTags: ["bulk"],
          confirmationId: asked.confirmationId,
        }),
      }),
    );

    expect(elsewhere.verdict).toBe("deny");
    expect(elsewhere.message).toContain("issued for a different call");
  });

  it("refuses an approval that expired while the modal was open", async () => {
    const asked = await ask();
    const id = asked.confirmationId as string;

    // Rewrite the stored expiry into the past, which is what waiting would do.
    const stored = await storage.consumeConfirmation(id);
    await storage.putConfirmation({
      ...(stored as NonNullable<typeof stored>),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const late = await ask({ confirmationId: id });
    expect(late.verdict).toBe("deny");
    expect(late.message).toContain("expired");
  });

  it("spends a stale id even when policy no longer asks for confirmation", async () => {
    const asked = await ask();
    await storage.updateRule("destructive-requires-confirmation", { enabled: false });

    const allowed = await ask({ confirmationId: asked.confirmationId });
    expect(allowed.verdict).toBe("allow");
    expect((await storage.getLog(allowed.callId))?.message).toContain("spent, not honoured");

    // Re-enabled, the id is gone: it was consumed on presentation.
    await storage.updateRule("destructive-requires-confirmation", { enabled: true });
    const reused = await ask({ confirmationId: asked.confirmationId });
    expect(reused.verdict).toBe("deny");
  });

  it("detokenizes only after the approval is accepted", async () => {
    const transform = await searchAndTransform({ patients: [{ mrn: "LM-100060" }] });
    const token = (transform.result as { patients: { mrn: string }[] }).patients[0].mrn;

    const asked = await ask({ args: { patient: token } });
    // Nothing came out of the vault while the call was merely pending.
    expect(asked.args).toBeUndefined();

    const approved = await ask({ confirmationId: asked.confirmationId, args: { patient: token } });
    expect(approved.verdict).toBe("allow");
    expect(approved.args).toEqual({ patient: "LM-100060" });
  });
});

/**
 * The justification flow. The rule the portal ships with is
 * `export_patients` → 40 characters, and the three outcomes are: nothing sent,
 * something useless sent, something real sent.
 */
describe("POST /gate — justification", () => {
  const GOOD_REASON =
    "Dr. Reyes asked for the hypertension cohort for Monday's care-gap review meeting.";

  const exportPayload = (overrides: Record<string, unknown> = {}) =>
    gatePayload({
      tool: "export_patients",
      args: {},
      toolTags: ["read", "phi", "bulk", "destructive-adjacent"],
      ...overrides,
    });

  async function exportCall(overrides: Record<string, unknown> = {}): Promise<GateResponse> {
    return payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: exportPayload(overrides) }),
    );
  }

  it("tells the agent exactly what to send when nothing was supplied", async () => {
    const gate = await exportCall();

    expect(gate.verdict).toBe("require-justification");
    expect(gate.args).toBeUndefined();
    expect(gate.message).toContain('call "export_patients" again');
    expect(gate.message).toContain("at least 40 characters");
    expect(gate.message).toContain("for whom");
    expect(gate.ruleIds).toEqual(["phi-transform-default", "export-requires-justification"]);

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({ status: "complete", verdict: "require-justification" });
    expect(entry?.justification).toBeUndefined();
  });

  it("rejects filler and records the evaluator's reason", async () => {
    const gate = await exportCall({ args: { justification: "because I need it" } });

    expect(gate.verdict).toBe("require-justification");
    expect(gate.message).toContain("The justification you sent was rejected");

    const entry = await storage.getLog(gate.callId);
    expect(entry?.justification).toBe("because I need it");
    expect(entry?.justificationVerdict).toMatchObject({ verdict: "fail" });
    expect(entry?.justificationVerdict?.reason).toContain("40");
  });

  it("passes a real justification, strips it, and keeps it in the log", async () => {
    const gate = await exportCall({
      args: { condition: "hypertension", justification: GOOD_REASON },
    });

    expect(gate.verdict).toBe("allow");
    // The tool never sees the guard's own argument: the portal's schemas are
    // additionalProperties:false, and it was never part of the tool contract.
    expect(gate.args).toEqual({ condition: "hypertension" });

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      status: "pending",
      verdict: "allow",
      justification: GOOD_REASON,
      justificationVerdict: { verdict: "pass" },
      payloads: {
        // The audit trail keeps what the agent actually sent…
        argsBefore: { condition: "hypertension", justification: GOOD_REASON },
        // …next to what the tool was handed.
        argsAfter: { condition: "hypertension" },
      },
    });
    expect(entry?.message).toContain("Justification accepted");
  });

  it("never detokenizes the justification text", async () => {
    const transform = await searchAndTransform({ patients: [{ mrn: "LM-100060" }] });
    const token = (transform.result as { patients: { mrn: string }[] }).patients[0].mrn;

    const gate = await exportCall({
      args: { justification: `${GOOD_REASON} Patient ${token}.` },
    });

    expect(gate.verdict).toBe("allow");
    expect(gate.args).toEqual({});
    // The stored justification still carries the token, not the real MRN.
    expect((await storage.getLog(gate.callId))?.justification).toContain(token);
    expect((await storage.getLog(gate.callId))?.justification).not.toContain("LM-100060");
  });

  it("honours a rule's own minimum", async () => {
    await storage.updateRule("export-requires-justification", {
      action: { type: "require-justification", minChars: 200 },
    });

    const gate = await exportCall({ args: { justification: GOOD_REASON } });
    expect(gate.verdict).toBe("require-justification");
    expect(gate.message).toContain("at least 200 characters");
  });

  it("uses a host-supplied evaluator when one is configured", async () => {
    const seen: string[] = [];
    const custom = createGuardServer(
      config(storage, {
        evaluator: {
          evaluate({ justification, tool, args, context }) {
            seen.push(justification);
            expect(tool).toBe("export_patients");
            expect(context.minChars).toBe(40);
            expect(context.ruleId).toBe("export-requires-justification");
            // The evaluator sees the arguments *without* the guard's own field.
            expect(args).toEqual({});
            return Promise.resolve({ verdict: "fail", reason: "Ticket number missing." });
          },
        },
      }),
    );
    await custom.ready();

    const gate = await payloadOf<GateResponse>(
      await send(custom, "POST", "gate", {
        payload: exportPayload({ args: { justification: GOOD_REASON } }),
      }),
    );

    expect(seen).toEqual([GOOD_REASON]);
    expect(gate.verdict).toBe("require-justification");
    expect(gate.message).toContain("Ticket number missing.");
  });

  it("falls back to the heuristic when the evaluator fails, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = createGuardServer(
      config(storage, {
        evaluator: {
          evaluate() {
            throw new Error("LLM provider unreachable");
          },
        },
      }),
    );
    await broken.ready();

    const gate = await payloadOf<GateResponse>(
      await send(broken, "POST", "gate", {
        payload: exportPayload({ args: { justification: GOOD_REASON } }),
      }),
    );

    // Evaluator downtime must never block the demo (docs/04).
    expect(gate.verdict).toBe("allow");
    const entry = await storage.getLog(gate.callId);
    expect(entry?.message).toContain("fell back to the built-in heuristic");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back when the evaluator answers with nonsense", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = createGuardServer(
      config(storage, {
        evaluator: {
          evaluate: () =>
            ({ verdict: "maybe" }) as unknown as { verdict: "pass" | "fail"; reason: string },
        },
      }),
    );
    await weird.ready();

    const gate = await payloadOf<GateResponse>(
      await send(weird, "POST", "gate", {
        payload: exportPayload({ args: { justification: "nope" } }),
      }),
    );

    // The heuristic decided — and it says four characters is not a reason.
    expect(gate.verdict).toBe("require-justification");
    warn.mockRestore();
  });
});

/**
 * Posture, through the real route. The engine's matrix is covered in
 * `policy-engine.test.ts`; what matters here is that `/gate` actually passes the
 * snapshot to it, and that the seeded pack stays inert until an administrator
 * turns it on.
 */
describe("POST /gate — posture", () => {
  const headless = {
    isSecureContext: true,
    timestamp: "2026-08-29T12:00:00.000Z",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "HeadlessChrome/151.0.0.0 Safari/537.36",
  };

  it("does nothing while the pack ships disabled", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload({ posture: headless }) }),
    );
    expect(gate.verdict).toBe("allow");
  });

  it("denies an unidentified agent once the rule is enabled", async () => {
    await storage.updateRule("posture-deny-unknown-agent", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload({ posture: headless }) }),
    );

    expect(gate.verdict).toBe("deny");
    // The transform rule matched too (the call is phi-tagged); the posture rule
    // is the one that decided the verdict.
    expect(gate.ruleIds).toContain("posture-deny-unknown-agent");
    expect(gate.message).toContain("agents it can identify");
  });

  it("lets an identified agent through the same rule", async () => {
    await storage.updateRule("posture-deny-unknown-agent", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({ posture: { ...headless, agentId: "chatgpt-atlas" } }),
      }),
    );
    expect(gate.verdict).toBe("allow");
  });

  it("denies a pre-WebMCP browser through the UA fallback", async () => {
    await storage.updateRule("posture-deny-old-browser", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          posture: {
            ...headless,
            agentId: "chatgpt-atlas",
            userAgent:
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
          },
        }),
      }),
    );

    expect(gate.verdict).toBe("deny");
    expect(gate.ruleIds).toContain("posture-deny-old-browser");
    expect(gate.message).toContain("older than Chrome 149");
  });

  it("does not fire a posture rule for a call that sent no posture at all", async () => {
    await storage.updateRule("posture-deny-unknown-agent", { enabled: true });

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    // Permissive by design — see `agentMatches` in policy-engine.ts.
    expect(gate.verdict).toBe("allow");
  });
});

/**
 * `GET /policies/effective` — the one policy read the page itself may make.
 * Two properties matter: it works without the admin token, and it says as
 * little as possible.
 */
describe("GET /policies/effective", () => {
  async function effective(query: Record<string, string>, token?: string) {
    const response = await send(guard, "GET", "policies/effective", {
      query,
      ...(token !== undefined ? { token } : {}),
    });
    return { response, payload: await payloadOf<Record<string, unknown>>(response.clone()) };
  }

  it("answers without the admin token, like /gate", async () => {
    const { response, payload } = await effective({ app: APP, tool: "search_patients" });

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      requiresJustification: false,
      minChars: null,
      requiresConfirmation: false,
      disabled: false,
    });
  });

  it("reports the justification requirement and its minimum", async () => {
    const { payload } = await effective({ app: APP, tool: "export_patients" });
    expect(payload).toEqual({
      requiresJustification: true,
      minChars: 40,
      requiresConfirmation: false,
      disabled: false,
    });
  });

  it("resolves tag-scoped rules from the comma list", async () => {
    const withTags = await effective({
      app: APP,
      tool: "delete_patient",
      tags: "write,destructive",
    });
    expect(withTags.payload).toMatchObject({
      requiresConfirmation: true,
      requiresJustification: false,
    });

    // Without the tags the tag-scoped rule cannot match — same as at the gate.
    const withoutTags = await effective({ app: APP, tool: "delete_patient" });
    expect(withoutTags.payload).toMatchObject({ requiresConfirmation: false });
  });

  it("leaks no rule internals", async () => {
    const { payload } = await effective({ app: APP, tool: "export_patients" });
    expect(Object.keys(payload).sort()).toEqual([
      "disabled",
      "minChars",
      "requiresConfirmation",
      "requiresJustification",
    ]);
    expect(JSON.stringify(payload)).not.toContain("export-requires-justification");
  });

  it("follows a live policy edit", async () => {
    await storage.updateRule("export-requires-justification", { enabled: false });
    expect((await effective({ app: APP, tool: "export_patients" })).payload).toMatchObject({
      requiresJustification: false,
      minChars: null,
    });

    await storage.updateRule("export-requires-justification", {
      enabled: true,
      action: { type: "require-justification", minChars: 120 },
    });
    expect((await effective({ app: APP, tool: "export_patients" })).payload).toMatchObject({
      requiresJustification: true,
      minChars: 120,
    });
  });

  it("defaults minChars when the rule does not name one", async () => {
    await storage.updateRule("export-requires-justification", {
      action: { type: "require-justification" },
    });
    expect((await effective({ app: APP, tool: "export_patients" })).payload).toMatchObject({
      minChars: 40,
    });
  });

  it("requires app and tool", async () => {
    expect((await send(guard, "GET", "policies/effective", { query: { app: APP } })).status).toBe(
      400,
    );
    expect((await send(guard, "GET", "policies/effective", { query: { tool: "x" } })).status).toBe(
      400,
    );
  });

  it("rejects other methods", async () => {
    const response = await send(guard, "DELETE", "policies/effective", { token: ADMIN_TOKEN });
    expect(response.status).toBe(405);
  });

  it("cannot be shadowed by a rule called 'effective'", async () => {
    const response = await send(guard, "POST", "policies", {
      token: ADMIN_TOKEN,
      payload: { id: "effective", name: "Sneaky", match: {}, action: { type: "allow" } },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("reserved");
  });
});

describe("POST /transform", () => {
  async function gateAllow(overrides: Record<string, unknown> = {}): Promise<GateResponse> {
    return payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload(overrides) }),
    );
  }

  it("completes the pending entry with the transformed result and the classes found", async () => {
    const gate = await gateAllow();
    const raw = { patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] };

    const response = await send(guard, "POST", "transform", {
      payload: { app: APP, tool: "search_patients", callId: gate.callId, result: raw },
    });

    const transform = await payloadOf<TransformResponse>(response);
    expect(response.status).toBe(200);

    const patient = (transform.result as typeof raw).patients[0];
    expect(patient.name).toMatch(/^tok_name_[0-9a-f]{8}$/);
    expect(patient.mrn).toMatch(/^tok_mrn_[0-9a-f]{8}$/);
    expect(transform.classesFound).toEqual(["mrn", "name"]);
    // Only the transform-aspect rule is reported back on this half.
    expect(transform.ruleIds).toEqual(["phi-transform-default"]);

    // Both tokens are in the vault, so the next call can pass them back.
    expect(await storage.getVaultEntry(patient.mrn)).not.toBeNull();
    expect(await storage.getVaultEntry(patient.name)).not.toBeNull();

    const entry = await storage.getLog(gate.callId);
    expect(entry).toMatchObject({
      status: "complete",
      verdict: "allow",
      dataClasses: ["mrn", "name"],
      payloads: {
        argsBefore: { query: "hypertension" },
        // The audit trail keeps the original alongside what the agent received.
        resultBefore: raw,
        resultAfter: { patients: [{ name: patient.name, mrn: patient.mrn }] },
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

/**
 * Phase 3, end to end through the routes: a result goes out tokenized, the
 * agent hands a token back, and the gate turns it into the real value before
 * the site's own code ever runs (`docs/03` steps 4–8).
 */
describe("the data pipeline through /gate and /transform", () => {
  it("round-trips a token from a result back into the next call's args", async () => {
    const transform = await searchAndTransform({
      patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }],
    });
    const token = (transform.result as { patients: { mrn: string }[] }).patients[0].mrn;

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({ tool: "get_patient", args: { patient: token } }),
      }),
    );

    expect(gate.verdict).toBe("allow");
    expect(gate.args).toEqual({ patient: "LM-100001" });

    const entry = await storage.getLog(gate.callId);
    expect(entry?.payloads.argsBefore).toEqual({ patient: token });
    expect(entry?.payloads.argsAfter).toEqual({ patient: "LM-100001" });
    expect(entry?.message).toContain("Detokenized 1 argument value");
    // The MRN the tool is about to receive is classified on the way in. The
    // `patient` key claims no class, so the value goes through the free-text
    // detectors and is reported as both.
    expect(entry?.dataClasses).toEqual(["mrn", "free_text_phi"]);
  });

  it("substitutes tokens buried inside free text", async () => {
    const transform = await searchAndTransform({
      patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }],
    });
    const { name, mrn } = (transform.result as { patients: { name: string; mrn: string }[] })
      .patients[0];

    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "add_visit_note",
          args: { patient: mrn, note: `Called ${name} about the refill.` },
        }),
      }),
    );

    expect(gate.args).toEqual({
      patient: "LM-100001",
      note: "Called Ada Whitfield about the refill.",
    });
  });

  it("leaves a token the vault has never seen exactly as it arrived", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({ tool: "get_patient", args: { patient: "tok_mrn_deadbeef" } }),
      }),
    );

    expect(gate.verdict).toBe("allow");
    expect(gate.args).toEqual({ patient: "tok_mrn_deadbeef" });
    expect((await storage.getLog(gate.callId))?.message).toBeUndefined();
  });

  it("never detokenizes for a verdict that is not allow", async () => {
    const transform = await searchAndTransform({ patients: [{ mrn: "LM-100060" }] });
    const token = (transform.result as { patients: { mrn: string }[] }).patients[0].mrn;

    const vaultReads = vi.spyOn(storage, "getVaultEntry");
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", {
        payload: gatePayload({
          tool: "delete_patient",
          args: { patient: token },
          toolTags: ["write", "destructive"],
        }),
      }),
    );

    expect(gate.verdict).toBe("require-confirmation");
    expect(gate.args).toBeUndefined();
    // A call that has not been allowed must not be usable as a
    // detokenization oracle, whichever verdict stopped it.
    expect(vaultReads).not.toHaveBeenCalled();

    const entry = await storage.getLog(gate.callId);
    expect(entry?.payloads.argsBefore).toEqual({ patient: token });
    expect(entry?.payloads.argsAfter).toEqual({ patient: token });
    vaultReads.mockRestore();
  });

  it("honours a policy edit made between the gate call and the transform call", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );

    // The console changes the matrix while the tool is still running.
    await storage.updateRule("phi-transform-default", {
      action: {
        type: "transform",
        perClass: PerClassTransformSchema.parse({ name: "mask", mrn: "passthrough" }),
      },
    });

    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ name: "Ada Whitfield", mrn: "LM-100001" }] },
        },
      }),
    );

    expect(transform.result).toEqual({ patients: [{ name: "▪▪▪", mrn: "LM-100001" }] });
  });

  it("stops transforming when the matched rule is disabled mid-call", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    await storage.updateRule("phi-transform-default", { enabled: false });

    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ mrn: "LM-100001" }] },
        },
      }),
    );

    expect(transform.result).toEqual({ patients: [{ mrn: "LM-100001" }] });
    expect(transform.ruleIds).toEqual([]);
    // Classification still happened, so the audit log records what went out.
    expect(transform.classesFound).toEqual(["mrn"]);
  });

  it("scans free text against the host's name dictionary, and caches it", async () => {
    const nameDictionary = vi.fn(() => ["Ada Whitfield"]);
    const dictionaryGuard = createGuardServer(
      config(memoryStorage(), { nameDictionary, nameDictionaryTtlMs: 60_000 }),
    );
    await dictionaryGuard.ready();

    const gate = await payloadOf<GateResponse>(
      await send(dictionaryGuard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(dictionaryGuard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { notes: [{ body: "Ada Whitfield called about a refill." }] },
        },
      }),
    );

    const body = (transform.result as { notes: { body: string }[] }).notes[0].body;
    expect(body).toMatch(/^tok_name_[0-9a-f]{8} called about a refill\.$/);
    expect(transform.classesFound).toEqual(["name", "free_text_phi"]);

    // Gate and transform both classified, but the host was asked once.
    expect(nameDictionary).toHaveBeenCalledTimes(1);
  });

  it("gives a bare first name in prose the same token as the structured field", async () => {
    // The leak found in live testing: a seeded note reading "Reached Tricia by
    // phone" left the given name in the clear beside a tokenized full name.
    const nameDictionary = vi.fn(() => ["Tricia Bashirian", "Ada Whitfield"]);
    const dictionaryGuard = createGuardServer(config(memoryStorage(), { nameDictionary }));
    await dictionaryGuard.ready();

    const gate = await payloadOf<GateResponse>(
      await send(dictionaryGuard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(dictionaryGuard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: {
            patients: [{ name: "Tricia Bashirian" }],
            notes: [{ body: "Reached Tricia by phone; Ms. Bashirian will call back." }],
          },
        },
      }),
    );

    const result = transform.result as {
      patients: { name: string }[];
      notes: { body: string }[];
    };
    const token = result.patients[0].name;

    expect(token).toMatch(/^tok_name_[0-9a-f]{8}$/);
    expect(result.notes[0].body).toBe(`Reached ${token} by phone; ${token} will call back.`);
  });

  it("emits a privacy notice naming the rule and only the mechanisms it used", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ mrn: "LM-100001", dob: "1985-04-12" }] },
        },
      }),
    );

    const notice = transform.notice ?? "";
    expect(notice).toContain("Tokenize PHI on phi-tagged tools (phi-transform-default)");
    expect(notice).toContain("tok_name_1a2b3c4d");
    expect(notice).toContain("Generalized values");
    // Nothing on this result was masked, so masks go unmentioned.
    expect(notice).not.toContain("Masked");
  });

  it("sends no notice when the transform changed nothing", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          // Clinical data the shipped matrix does not name.
          result: { patients: [{ primaryConditions: ["Hypertension"], visits: 3 }] },
        },
      }),
    );

    expect(transform.result).toEqual({
      patients: [{ primaryConditions: ["Hypertension"], visits: 3 }],
    });
    expect(transform.notice).toBeUndefined();
  });

  it("sends no notice when no transform rule matched at all", async () => {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    await storage.updateRule("phi-transform-default", { enabled: false });

    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ ssn: "927-78-1337" }] },
        },
      }),
    );

    expect(transform.notice).toBeUndefined();
  });

  it("keeps working when the host's name dictionary throws", async () => {
    const nameDictionary = vi.fn(() => {
      throw new Error("database is down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenGuard = createGuardServer(config(memoryStorage(), { nameDictionary }));
    await brokenGuard.ready();

    const gate = await payloadOf<GateResponse>(
      await send(brokenGuard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(brokenGuard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ mrn: "LM-100001" }] },
        },
      }),
    );

    // The other two passes still fire.
    expect((transform.result as { patients: { mrn: string }[] }).patients[0].mrn).toMatch(
      /^tok_mrn_/,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses a deployment's own MRN pattern", async () => {
    const custom = createGuardServer(config(memoryStorage(), { mrnPattern: /\bREC\d{4}\b/g }));
    await custom.ready();

    const gate = await payloadOf<GateResponse>(
      await send(custom, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(custom, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { notes: [{ body: "Chart REC0042 and LM-100001." }] },
        },
      }),
    );

    const body = (transform.result as { notes: { body: string }[] }).notes[0].body;
    expect(body).toMatch(/^Chart tok_mrn_[0-9a-f]{8} and LM-100001\.$/);
  });
});

describe("POST /tokens/reveal", () => {
  /** Puts one real vault row in place by running a result through /transform. */
  async function seedVault(): Promise<{ token: string; callId: string }> {
    const gate = await payloadOf<GateResponse>(
      await send(guard, "POST", "gate", { payload: gatePayload() }),
    );
    const transform = await payloadOf<TransformResponse>(
      await send(guard, "POST", "transform", {
        payload: {
          app: APP,
          tool: "search_patients",
          callId: gate.callId,
          result: { patients: [{ ssn: "927-78-1337" }] },
        },
      }),
    );
    return {
      token: (transform.result as { patients: { ssn: string }[] }).patients[0].ssn,
      callId: gate.callId,
    };
  }

  it("refuses an unauthenticated reveal", async () => {
    const { token } = await seedVault();
    const response = await send(guard, "POST", "tokens/reveal", { payload: { token } });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthorized");
    // Nothing was revealed, so nothing was logged.
    expect((await storage.queryLogs({ app: "webmcp-guard" })).total).toBe(0);
  });

  it("returns the original value to an admin and logs the reveal", async () => {
    const { token } = await seedVault();

    const response = await send(guard, "POST", "tokens/reveal", {
      payload: { token },
      token: ADMIN_TOKEN,
    });
    expect(response.status).toBe(200);
    expect(await payloadOf(response)).toEqual({
      token,
      dataClass: "ssn",
      value: "927-78-1337",
    });

    const audit = await storage.queryLogs({ app: "webmcp-guard" });
    expect(audit.total).toBe(1);
    expect(audit.entries[0]).toMatchObject({
      app: "webmcp-guard",
      tool: "console_reveal",
      verdict: "allow",
      status: "complete",
    });
    expect(audit.entries[0].message).toContain(token);
    expect(audit.entries[0].message).toContain("ssn");
    // The audit entry names what was revealed; it never copies the plaintext.
    expect(JSON.stringify(audit.entries[0])).not.toContain("927-78-1337");
  });

  it("404s an unknown token without writing an audit entry", async () => {
    const response = await send(guard, "POST", "tokens/reveal", {
      payload: { token: "tok_ssn_deadbeef" },
      token: ADMIN_TOKEN,
    });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    expect((await storage.queryLogs({ app: "webmcp-guard" })).total).toBe(0);
  });

  it("acknowledges and logs a payload reveal by log id", async () => {
    const { callId } = await seedVault();

    const response = await send(guard, "POST", "tokens/reveal", {
      payload: { logId: callId },
      token: ADMIN_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(await payloadOf(response)).toEqual({ logId: callId, acknowledged: true });

    const audit = await storage.queryLogs({ app: "webmcp-guard" });
    expect(audit.total).toBe(1);
    expect(audit.entries[0].message).toContain(callId);
    expect(audit.entries[0].message).toContain("payloads");
  });

  it("404s an unknown log id", async () => {
    const response = await send(guard, "POST", "tokens/reveal", {
      payload: { logId: "not-a-log" },
      token: ADMIN_TOKEN,
    });
    expect(response.status).toBe(404);
  });

  it("requires at least one of token and logId", async () => {
    const response = await send(guard, "POST", "tokens/reveal", {
      payload: {},
      token: ADMIN_TOKEN,
    });
    expect(response.status).toBe(400);
  });

  it("reports a row it cannot decrypt rather than pretending it is unknown", async () => {
    const { token } = await seedVault();
    const entry = await storage.getVaultEntry(token);
    if (entry === null) throw new Error("expected a vault entry");

    const tampered = Buffer.from(entry.authTag, "base64");
    tampered[0] ^= 0xff;
    // Reach past the first-write-wins guard to simulate a corrupted store.
    (storage as unknown as { reset(): void }).reset();
    await storage.putVaultEntry({ ...entry, authTag: tampered.toString("base64") });

    const response = await send(guard, "POST", "tokens/reveal", {
      payload: { token },
      token: ADMIN_TOKEN,
    });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).toContain("GUARD_VAULT_KEY");
  });

  it("rejects other methods and unknown token routes", async () => {
    expect((await send(guard, "GET", "tokens/reveal", { token: ADMIN_TOKEN })).status).toBe(405);
    expect((await send(guard, "POST", "tokens/lookup", { token: ADMIN_TOKEN })).status).toBe(404);
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
    const id = "destructive-requires-confirmation";
    const first = await send(guard, "DELETE", `policies/${id}`, { token });
    expect(first.status).toBe(200);
    expect(await payloadOf(first)).toEqual({ id, deleted: true });

    const second = await send(guard, "DELETE", `policies/${id}`, { token });
    expect(second.status).toBe(404);
  });

  it("reorders rules and reports the new order", async () => {
    const document = await payloadOf<PolicyDocument>(
      await send(guard, "POST", "policies/reorder", {
        token,
        payload: { ids: ["destructive-requires-confirmation", "phi-transform-default"] },
      }),
    );

    expect(document.rules.map((rule) => rule.id).slice(0, 2)).toEqual([
      "destructive-requires-confirmation",
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
    await send(guard, "PUT", "policies/destructive-requires-confirmation", {
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

    const held = await payloadOf<LogPage>(
      await send(guard, "GET", "logs", { token, query: { verdict: "require-confirmation" } }),
    );
    expect(held.entries.map((entry) => entry.tool)).toEqual(["delete_patient"]);
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
    await storage.createRule({
      id: "stats-deny",
      name: "Deny deletes",
      priority: 1,
      match: { tools: ["delete_patient"] },
      action: { type: "deny", message: "Not from an agent." },
    });

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
