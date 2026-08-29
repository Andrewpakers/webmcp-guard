import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PACKAGE_NAME,
  WEBMCP_UNAVAILABLE_WARNING,
  createGuard,
  detectWebMcpSurface,
  resetWebMcpWarning,
} from "./index";
import {
  StubModelContext,
  clearBrowserGlobals,
  createFetchStub,
  defineGlobal,
  effectivePolicyResponse,
  envelopeResponse,
  makeToolDefinition,
  restoreBrowserGlobals,
} from "./test-support";
import type { GuardEvent, GuardToolDefinition } from "./types";

/**
 * Registration behavior (`docs/04` behaviors 1 and 2). The pipeline itself is
 * covered in `pipeline.test.ts`.
 */

const guardOptions = { endpoint: "/api/guard", app: "lakeside-portal" } as const;

beforeEach(() => {
  clearBrowserGlobals();
  resetWebMcpWarning();
});

afterEach(() => {
  restoreBrowserGlobals();
  vi.restoreAllMocks();
});

describe("createGuard — configuration", () => {
  it("is wired into the workspace test run", () => {
    expect(PACKAGE_NAME).toBe("@webmcp-guard/sdk");
  });

  it("rejects a missing or blank endpoint", () => {
    expect(() => createGuard({ ...guardOptions, endpoint: "" })).toThrow(TypeError);
    expect(() => createGuard({ ...guardOptions, endpoint: "   " })).toThrow(/endpoint/);
    expect(() => createGuard({ app: "x" } as unknown as Parameters<typeof createGuard>[0])).toThrow(
      /endpoint/,
    );
  });

  it("rejects a missing or blank app", () => {
    expect(() => createGuard({ ...guardOptions, app: "" })).toThrow(/app/);
  });

  it("never throws just because the browser has no WebMCP", () => {
    expect(() => createGuard(guardOptions)).not.toThrow();
  });
});

describe("availability", () => {
  it("reports false with no WebMCP anywhere", () => {
    const guard = createGuard(guardOptions);
    expect(guard.available).toBe(false);
    expect(guard.surface).toBe("unavailable");
    expect(detectWebMcpSurface()).toBe("unavailable");
  });

  it("reports false when the globals exist but carry no model context", () => {
    defineGlobal("document", {});
    defineGlobal("navigator", {});
    expect(createGuard(guardOptions).available).toBe(false);
  });

  it("prefers the document surface and re-detects on every read", () => {
    const guard = createGuard(guardOptions);
    expect(guard.available).toBe(false);

    defineGlobal("navigator", { modelContext: new StubModelContext() });
    expect(guard.surface).toBe("navigator");

    // A guard created before WebMCP appeared still sees it (script order and
    // ChatGPT's in-app browser both make this ordering real).
    defineGlobal("document", { modelContext: new StubModelContext() });
    expect(guard.surface).toBe("document");
    expect(guard.available).toBe(true);
  });
});

describe("graceful degradation", () => {
  it("warns exactly once per page and resolves registrations as no-ops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guard = createGuard(guardOptions);

    const first = await guard.registerTool(makeToolDefinition());
    const second = await guard.registerTool(makeToolDefinition({ name: "get_patient" }));

    expect(first).toEqual({ tool: "search_patients", surface: "unavailable", registered: false });
    expect(second.registered).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(WEBMCP_UNAVAILABLE_WARNING);
    expect(WEBMCP_UNAVAILABLE_WARNING).toContain("chrome://flags/#enable-webmcp-testing");
  });

  it("warns once even across separate guard instances", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createGuard(guardOptions).registerTool(makeToolDefinition());
    await createGuard(guardOptions).registerTool(makeToolDefinition());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("registration — document surface", () => {
  let modelContext: StubModelContext;

  beforeEach(() => {
    modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
  });

  it("registers through document.modelContext.registerTool", async () => {
    const guard = createGuard(guardOptions);
    const result = await guard.registerTool(makeToolDefinition());

    expect(result).toEqual({ tool: "search_patients", surface: "document", registered: true });
    expect(modelContext.tools.has("search_patients")).toBe(true);
  });

  it("prefers document even when navigator also exposes WebMCP", async () => {
    const legacy = new StubModelContext();
    defineGlobal("navigator", { modelContext: legacy });

    await createGuard(guardOptions).registerTool(makeToolDefinition());

    expect(modelContext.calls).toHaveLength(1);
    expect(legacy.calls).toHaveLength(0);
  });

  it("strips the guard-only `tags` field from what the browser sees", async () => {
    await createGuard(guardOptions).registerTool(
      makeToolDefinition({ tags: ["read", "phi", "destructive"] }),
    );

    const registered = modelContext.lastCall?.tool;
    expect(registered).toBeDefined();
    expect(Object.keys(registered!).sort()).toEqual([
      "description",
      "execute",
      "inputSchema",
      "name",
    ]);
    expect("tags" in registered!).toBe(false);
  });

  it("forwards annotations as a copy, and drops unknown host fields", async () => {
    const annotations = { readOnlyHint: true, untrustedContentHint: false };
    const definition = makeToolDefinition({ annotations }) as GuardToolDefinition & {
      secretInternalField?: string;
    };
    definition.secretInternalField = "must not reach the browser";

    await createGuard(guardOptions).registerTool(definition);

    const registered = modelContext.lastCall!.tool;
    expect(Object.keys(registered).sort()).toEqual([
      "annotations",
      "description",
      "execute",
      "inputSchema",
      "name",
    ]);
    expect(registered.annotations).toEqual(annotations);
    expect(registered.annotations).not.toBe(annotations);

    annotations.readOnlyHint = false;
    expect(registered.annotations?.readOnlyHint).toBe(true);
  });

  it("aborting the host's signal unregisters the tool", async () => {
    const controller = new AbortController();
    await createGuard(guardOptions).registerTool(makeToolDefinition(), {
      signal: controller.signal,
    });

    // The guard registers with a signal of its *own*, chained to the host's:
    // re-registering on a policy change means unregistering first (docs/08),
    // and the host's controller is not the guard's to abort. What the host
    // still owns is the outcome — aborting must unregister, as it always did.
    const registered = modelContext.lastCall?.options?.signal;
    expect(registered).toBeInstanceOf(AbortSignal);
    expect(registered).not.toBe(controller.signal);
    expect(modelContext.tools.size).toBe(1);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("registers nothing against an already-aborted signal (StrictMode's first mount)", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await createGuard(guardOptions).registerTool(makeToolDefinition(), {
      signal: controller.signal,
    });

    expect(result.registered).toBe(false);
    expect(modelContext.calls).toHaveLength(0);
  });

  it("survives a StrictMode double register/abort race", async () => {
    const guard = createGuard(guardOptions);
    const first = new AbortController();
    const second = new AbortController();

    // Both mounts register before either cleanup runs — the overlapping case.
    await Promise.all([
      guard.registerTool(makeToolDefinition(), { signal: first.signal }),
      guard.registerTool(makeToolDefinition(), { signal: second.signal }),
    ]);
    first.abort();

    expect(modelContext.calls).toHaveLength(2);
    expect(modelContext.tools.size).toBe(1);
    expect(modelContext.tools.has("search_patients")).toBe(true);

    second.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("reports a browser-rejected registration instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    modelContext.rejectWith = new Error("invalid tool name");

    const guard = createGuard(guardOptions);
    const events: GuardEvent[] = [];
    guard.subscribe((event) => events.push(event));

    const result = await guard.registerTool(makeToolDefinition());

    expect(result).toEqual({ tool: "search_patients", surface: "document", registered: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].detail).toContain("invalid tool name");
  });

  it("registers a working, guarded execute", async () => {
    const fetchStub = createFetchStub({
      gate: () => envelopeResponse({ callId: "c1", verdict: "allow", ruleIds: [] }),
      transform: () => envelopeResponse({ result: "clean", classesFound: [], ruleIds: [] }),
    });
    const guard = createGuard({ ...guardOptions, fetchImpl: fetchStub.fetchImpl });
    await guard.registerTool(makeToolDefinition());

    await expect(
      modelContext.executeToolWithoutContext("search_patients", { query: "smith" }),
    ).resolves.toBe("clean");
  });
});

/**
 * Schema rewriting from policy (`docs/04` behavior 3) and the re-registration
 * that keeps it current (`docs/08`: policy change = abort + register).
 *
 * The rewriting itself is unit-tested in `schema.test.ts`; what matters here is
 * that registration actually *asks*, that a guard it cannot reach never stops a
 * tool from registering, and that a policy flip reaches the browser.
 */
describe("effective policy at registration", () => {
  let modelContext: StubModelContext;

  beforeEach(() => {
    modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
  });

  /** The schema the browser was handed on the most recent registration. */
  function registeredSchema(): Record<string, unknown> {
    return (modelContext.lastCall?.tool.inputSchema ?? {}) as Record<string, unknown>;
  }

  function guardWith(policies: Parameters<typeof createFetchStub>[0]["policies"]) {
    const fetchStub = createFetchStub({
      gate: () => envelopeResponse({ callId: "c1", verdict: "allow", ruleIds: [] }),
      transform: () => envelopeResponse({ result: "ok", classesFound: [], ruleIds: [] }),
      ...(policies ? { policies } : {}),
    });
    return {
      fetchStub,
      guard: createGuard({ ...guardOptions, fetchImpl: fetchStub.fetchImpl, policyRefreshMs: 0 }),
    };
  }

  it("asks the guard about the tool it is registering", async () => {
    const { fetchStub, guard } = guardWith(undefined);
    await guard.registerTool(makeToolDefinition({ tags: ["read", "phi"] }));

    expect(fetchStub.policyCalls).toHaveLength(1);
    const url = new URL(fetchStub.policyCalls[0].url, "https://portal.test");
    expect(url.pathname).toBe("/api/guard/policies/effective");
    expect(url.searchParams.get("app")).toBe("lakeside-portal");
    expect(url.searchParams.get("tool")).toBe("search_patients");
    expect(url.searchParams.get("tags")).toBe("read,phi");
    expect(fetchStub.policyCalls[0].init.method).toBe("GET");
  });

  it("injects a required justification property when policy asks for one", async () => {
    const { guard } = guardWith(() =>
      effectivePolicyResponse({ requiresJustification: true, minChars: 40 }),
    );
    await guard.registerTool(makeToolDefinition());

    const schema = registeredSchema();
    expect(schema.required).toEqual(["justification"]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.justification.type).toBe("string");
    expect(String(properties.justification.description)).toContain("40 characters");
    // The host's own property survives.
    expect(properties.query).toEqual({ type: "string" });
  });

  it("never mutates the definition the host handed it", async () => {
    const { guard } = guardWith(() =>
      effectivePolicyResponse({ requiresJustification: true, minChars: 40 }),
    );
    const definition = makeToolDefinition();
    const before = JSON.parse(JSON.stringify(definition.inputSchema)) as unknown;

    await guard.registerTool(definition);

    expect(definition.inputSchema).toEqual(before);
    expect(definition.inputSchema).not.toBe(registeredSchema());
  });

  it("registers without injection when policy asks for nothing", async () => {
    const { guard } = guardWith(undefined);
    await guard.registerTool(makeToolDefinition());

    expect(registeredSchema()).toEqual(makeToolDefinition().inputSchema);
  });

  /**
   * Availability over enforcement, at the schema layer only: the gate still
   * re-decides every call server-side, so the worst case here is an agent that
   * learns about the requirement one turn later instead of from the schema.
   * Refusing to register would be far worse — it would take the site's tools
   * off the air because a policy read failed.
   */
  it("still registers when the guard cannot be reached", async () => {
    const { guard } = guardWith(() => {
      throw new TypeError("Failed to fetch");
    });

    const result = await guard.registerTool(makeToolDefinition());

    expect(result.registered).toBe(true);
    expect(registeredSchema()).toEqual(makeToolDefinition().inputSchema);
  });

  it("ignores an answer that is not the wire contract", async () => {
    const { guard } = guardWith(() => envelopeResponse({ requiresJustification: "yes" }));

    const result = await guard.registerTool(makeToolDefinition());

    expect(result.registered).toBe(true);
    expect(registeredSchema()).toEqual(makeToolDefinition().inputSchema);
  });

  it("ignores a 404 from a guard server that predates the endpoint", async () => {
    const { guard } = guardWith(() => new Response("nope", { status: 404 }));

    await expect(guard.registerTool(makeToolDefinition())).resolves.toMatchObject({
      registered: true,
    });
  });
});

describe("re-registration on a policy change", () => {
  let modelContext: StubModelContext;
  let policy: { requiresJustification: boolean; minChars: number | null };

  beforeEach(() => {
    modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
    policy = { requiresJustification: false, minChars: null };
  });

  function guardWith(options: { policyRefreshMs?: number } = {}) {
    const fetchStub = createFetchStub({
      gate: () => envelopeResponse({ callId: "c1", verdict: "allow", ruleIds: [] }),
      transform: () => envelopeResponse({ result: "ok", classesFound: [], ruleIds: [] }),
      policies: () => effectivePolicyResponse(policy),
    });
    return {
      fetchStub,
      guard: createGuard({
        ...guardOptions,
        fetchImpl: fetchStub.fetchImpl,
        policyRefreshMs: options.policyRefreshMs ?? 0,
      }),
    };
  }

  function liveSchema(): Record<string, unknown> {
    const tool = modelContext.tools.get("search_patients");
    return (tool?.inputSchema ?? {}) as Record<string, unknown>;
  }

  it("aborts the old registration and registers the new schema", async () => {
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());
    expect(liveSchema().required).toBeUndefined();

    policy = { requiresJustification: true, minChars: 40 };
    await expect(guard.refreshPolicies()).resolves.toBe(1);

    // docs/08: re-registration is abort + register. Exactly one live tool, with
    // the new schema, and the old registration is gone.
    expect(modelContext.calls).toHaveLength(2);
    expect(modelContext.tools.size).toBe(1);
    expect(liveSchema().required).toEqual(["justification"]);
    expect(modelContext.calls[0].live).toBe(false);
  });

  /**
   * Regression: Chromium 151 keeps the tool it already has when the same name
   * is registered again, so the old registration has to be aborted *first*.
   * Registering the replacement first left the page on the stale schema
   * forever — caught in the headless e2e run, not by the stub.
   */
  it("unregisters before it registers, so a live name is free", async () => {
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());

    policy = { requiresJustification: true, minChars: 40 };
    await guard.refreshPolicies();

    expect(modelContext.calls[0].options?.signal?.aborted).toBe(true);
    // The replacement was registered against a signal that was still live.
    expect(modelContext.calls[1].options?.signal?.aborted).toBe(false);
  });

  /**
   * Regression: the host-abort listener used to close over the controller from
   * the *first* registration, so aborting after a policy flip unregistered
   * nothing and leaked the tool.
   */
  it("still unregisters on the host's signal after a re-registration", async () => {
    const { guard } = guardWith();
    const controller = new AbortController();
    await guard.registerTool(makeToolDefinition(), { signal: controller.signal });

    policy = { requiresJustification: true, minChars: 40 };
    await guard.refreshPolicies();
    expect(modelContext.tools.size).toBe(1);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("puts the old definition back when the replacement is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());

    policy = { requiresJustification: true, minChars: 40 };
    // The replacement is rejected; the restore that follows it is not.
    modelContext.rejectNextCalls = 1;

    await expect(guard.refreshPolicies()).resolves.toBe(0);
    // The page still has its tool, on the schema it had before.
    expect(modelContext.tools.size).toBe(1);
    expect(liveSchema().required).toBeUndefined();
    warn.mockRestore();
  });

  it("drops the justification field again when the rule is switched off", async () => {
    policy = { requiresJustification: true, minChars: 40 };
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());
    expect(liveSchema().required).toEqual(["justification"]);

    policy = { requiresJustification: false, minChars: null };
    await guard.refreshPolicies();

    expect(liveSchema().required).toBeUndefined();
    expect((liveSchema().properties as Record<string, unknown>).justification).toBeUndefined();
  });

  it("does nothing when the schema would not change", async () => {
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());

    await expect(guard.refreshPolicies()).resolves.toBe(0);
    expect(modelContext.calls).toHaveLength(1);
  });

  it("never runs two refresh passes at once", async () => {
    const { fetchStub, guard } = guardWith();
    await guard.registerTool(makeToolDefinition());
    const before = fetchStub.policyCalls.length;

    policy = { requiresJustification: true, minChars: 40 };
    const [first, second] = await Promise.all([guard.refreshPolicies(), guard.refreshPolicies()]);

    // Both callers share one pass: one policy read, one re-registration.
    expect([first, second]).toEqual([1, 1]);
    expect(fetchStub.policyCalls.length - before).toBe(1);
    expect(modelContext.calls).toHaveLength(2);
  });

  it("keeps the current registration when the guard stops answering", async () => {
    policy = { requiresJustification: true, minChars: 40 };
    const { guard } = guardWith();
    await guard.registerTool(makeToolDefinition());

    const offline = createGuard({
      ...guardOptions,
      policyRefreshMs: 0,
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    // The offline guard has no registrations of its own; the point is that the
    // live one keeps its schema when a refresh cannot read policy.
    await expect(offline.refreshPolicies()).resolves.toBe(0);
    expect(liveSchema().required).toEqual(["justification"]);
  });

  it("stops tracking a tool whose host signal aborted", async () => {
    const { guard } = guardWith();
    const controller = new AbortController();
    await guard.registerTool(makeToolDefinition(), { signal: controller.signal });

    controller.abort();
    policy = { requiresJustification: true, minChars: 40 };

    await expect(guard.refreshPolicies()).resolves.toBe(0);
    expect(modelContext.tools.size).toBe(0);
    expect(modelContext.calls).toHaveLength(1);
  });

  it("refreshes on a timer without being asked", async () => {
    vi.useFakeTimers();
    try {
      const { guard } = guardWith({ policyRefreshMs: 1000 });
      await guard.registerTool(makeToolDefinition());
      policy = { requiresJustification: true, minChars: 40 };

      await vi.advanceTimersByTimeAsync(1000);

      expect(liveSchema().required).toEqual(["justification"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs no timer at all when refreshing is disabled", async () => {
    vi.useFakeTimers();
    try {
      const { guard } = guardWith({ policyRefreshMs: 0 });
      await guard.registerTool(makeToolDefinition());
      policy = { requiresJustification: true, minChars: 40 };

      await vi.advanceTimersByTimeAsync(120_000);

      expect(liveSchema().required).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registration — legacy navigator surface", () => {
  it("falls back to navigator.modelContext.registerTool", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", {});
    defineGlobal("navigator", { modelContext });

    const controller = new AbortController();
    const result = await createGuard(guardOptions).registerTool(makeToolDefinition(), {
      signal: controller.signal,
    });

    expect(result).toEqual({ tool: "search_patients", surface: "navigator", registered: true });
    expect(modelContext.tools.size).toBe(1);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("is used when `document` does not exist at all", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("navigator", { modelContext });

    const result = await createGuard(guardOptions).registerTool(makeToolDefinition());
    expect(result.surface).toBe("navigator");
  });
});

describe("registration — WebMCP that vanishes mid-registration", () => {
  it("degrades instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modelContext = new StubModelContext();
    let reads = 0;
    defineGlobal("document", {
      get modelContext() {
        reads += 1;
        return reads <= 1 ? modelContext : undefined;
      },
    });

    const result = await createGuard(guardOptions).registerTool(makeToolDefinition());

    expect(result).toEqual({ tool: "search_patients", surface: "unavailable", registered: false });
    expect(modelContext.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("host type compatibility", () => {
  it("accepts a tool whose execute is typed like `webmcp-types`' ToolExecuteCallback", async () => {
    // The published typings declare `(input, options)` with a *required*
    // options argument. Host apps type their tools that way, so the guard's
    // definition type has to accept it — this test is really a compile check.
    const strictCallback = (
      input: Record<string, unknown>,
      options: { signal: AbortSignal },
    ): Promise<unknown> => {
      void options;
      return Promise.resolve(`ran with ${Object.keys(input).length} keys`);
    };

    const definition: GuardToolDefinition = {
      name: "strictly_typed",
      description: "Typed the way webmcp-types declares.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      tags: ["read"] as readonly string[],
      execute: strictCallback,
    };

    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
    await expect(createGuard(guardOptions).registerTool(definition)).resolves.toMatchObject({
      registered: true,
    });
  });
});
