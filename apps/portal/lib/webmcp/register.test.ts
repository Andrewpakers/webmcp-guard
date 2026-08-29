import { createGuard, resetWebMcpWarning } from "@webmcp-guard/sdk";
import { WIRE_VERSION } from "@webmcp-guard/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GUARD_APP, GUARD_ENDPOINT } from "./guard";
import {
  WEBMCP_ENABLE_HINT,
  countRegisteredTools,
  detectWebMcpSurface,
  registerPortalTools,
  resolveModelContext,
} from "./register";
import { PORTAL_TOOL_NAMES, createPortalTools } from "./tools";

/**
 * Registration now goes through `@webmcp-guard/sdk`, so these tests need two
 * doubles: a `modelContext` stub (WebMCP exists in no test environment — jsdom
 * included, which is why this suite stays in plain node) and a `fetch` stub for
 * the guard's `/gate` and `/transform` round trips.
 *
 * The pattern mirrors `packages/sdk/src/test-support.ts`, copied rather than
 * imported: that module is intentionally not part of the SDK's public exports.
 */

interface RegisterCall {
  tool: WebMCP.ModelContextTool;
  options?: WebMCP.ModelContextRegisterToolOptions;
  live: boolean;
}

/**
 * Stands in for `document.modelContext`.
 *
 * Registrations are tracked individually rather than by name, because that is
 * how the browser behaves: aborting one registration must not take down a
 * later registration of the same tool. React StrictMode produces exactly that
 * overlap, so the stub has to model it or the test proves nothing.
 */
class StubModelContext extends EventTarget {
  readonly calls: RegisterCall[] = [];
  ontoolchange: ((this: WebMCP.ModelContext, ev: Event) => unknown) | null = null;

  /** The tools currently exposed to an agent. */
  get tools(): Map<string, WebMCP.ModelContextTool> {
    const live = new Map<string, WebMCP.ModelContextTool>();
    for (const call of this.calls) {
      if (call.live) live.set(call.tool.name, call.tool);
    }
    return live;
  }

  registerTool(
    tool: WebMCP.ModelContextTool,
    options?: WebMCP.ModelContextRegisterToolOptions,
  ): Promise<void> {
    const entry: RegisterCall = { tool, options, live: !options?.signal?.aborted };
    this.calls.push(entry);

    if (entry.live) {
      options?.signal?.addEventListener("abort", () => {
        entry.live = false;
      });
    }
    return Promise.resolve();
  }

  getTools(): Promise<WebMCP.RegisteredTool[]> {
    return Promise.resolve(
      [...this.tools.values()].map(
        (tool) =>
          ({
            name: tool.name,
            title: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            origin: "https://lakeside.example",
          }) as WebMCP.RegisteredTool,
      ),
    );
  }

  /** Invokes a live tool the way Chromium 151 does: input only, no context. */
  execute(name: string, input?: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no live tool named ${name}`);
    return Promise.resolve((tool.execute as (input?: unknown) => unknown)(input));
  }
}

interface GuardCall {
  url: string;
  payload: Record<string, unknown>;
}

/**
 * Records every guard round trip and answers with the given verdict.
 *
 * Three endpoints now: the SDK reads `GET /policies/effective` once per tool at
 * registration time (Phase 5 schema injection) before `/gate` and `/transform`
 * ever run. `pipelineCalls` is the gate+transform pair one tool call makes.
 */
function guardFetchStub(options: { verdict?: string; message?: string } = {}) {
  const calls: GuardCall[] = [];
  const verdict = options.verdict ?? "allow";
  const isPolicyCall = (url: string) => url.includes("/policies/effective");

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "{}";
    const envelope = JSON.parse(body) as { payload?: Record<string, unknown> };
    const payload = envelope.payload ?? {};
    calls.push({ url, payload });

    const response = isPolicyCall(url)
      ? {
          requiresJustification: false,
          minChars: null,
          requiresConfirmation: false,
          disabled: false,
        }
      : url.endsWith("/gate")
        ? {
            callId: "call-1",
            verdict,
            ...(verdict === "allow" ? { args: payload.args } : {}),
            ...(options.message ? { message: options.message } : {}),
            ruleIds: [],
          }
        : { result: payload.result, classesFound: [], ruleIds: [] };

    return new Response(JSON.stringify({ version: WIRE_VERSION, payload: response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    get pipelineCalls() {
      return calls.filter((call) => !isPolicyCall(call.url));
    },
  };
}

function makeGuard(fetchImpl?: typeof fetch) {
  return createGuard({ endpoint: GUARD_ENDPOINT, app: GUARD_APP, fetchImpl });
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function defineGlobal(name: "document" | "navigator", value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function removeGlobal(name: "document" | "navigator"): void {
  delete (globalThis as Record<string, unknown>)[name];
}

/** No WebMCP anywhere — the baseline every test starts from. */
function clearWebMcpGlobals(): void {
  removeGlobal("document");
  removeGlobal("navigator");
}

beforeEach(() => {
  clearWebMcpGlobals();
  resetWebMcpWarning();
});

afterEach(() => {
  removeGlobal("document");
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    removeGlobal("navigator");
  }
  vi.restoreAllMocks();
});

describe("feature detection", () => {
  it("prefers document.modelContext", () => {
    defineGlobal("document", { modelContext: new StubModelContext() });
    defineGlobal("navigator", { modelContext: new StubModelContext() });
    expect(detectWebMcpSurface()).toBe("document");
  });

  it("falls back to the legacy navigator surface", () => {
    defineGlobal("document", {});
    defineGlobal("navigator", { modelContext: new StubModelContext() });
    expect(detectWebMcpSurface()).toBe("navigator");
  });

  it("reports unavailable when neither global exists", () => {
    expect(detectWebMcpSurface()).toBe("unavailable");
  });

  it("reports unavailable when the globals exist but carry no model context", () => {
    defineGlobal("document", {});
    defineGlobal("navigator", {});
    expect(detectWebMcpSurface()).toBe("unavailable");
    expect(resolveModelContext()).toBeNull();
  });
});

describe("registerPortalTools — document surface", () => {
  let modelContext: StubModelContext;
  let controller: AbortController;

  beforeEach(() => {
    modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
    controller = new AbortController();
  });

  it("registers all seven tools, in order, through the guard", async () => {
    const result = await registerPortalTools({ signal: controller.signal, guard: makeGuard() });

    expect(result.surface).toBe("document");
    expect(result.registered).toEqual([...PORTAL_TOOL_NAMES]);
    expect(modelContext.calls.map((c) => c.tool.name)).toEqual([...PORTAL_TOOL_NAMES]);
    expect(modelContext.tools.size).toBe(7);
  });

  it("registers with a signal chained to the caller's, so aborting unregisters", async () => {
    await registerPortalTools({ signal: controller.signal, guard: makeGuard() });

    // The SDK owns a controller per tool (it has to unregister to re-register
    // when policy changes — docs/08), so these are not the caller's signal.
    // What the caller still owns is the outcome, asserted in the next test.
    for (const call of modelContext.calls) {
      expect(call.options?.signal).toBeInstanceOf(AbortSignal);
      expect(call.options?.signal).not.toBe(controller.signal);
    }
    expect(modelContext.tools.size).toBe(7);
  });

  it("unregisters every tool when the signal aborts", async () => {
    await registerPortalTools({ signal: controller.signal, guard: makeGuard() });
    expect(modelContext.tools.size).toBe(7);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("registers nothing when the signal is already aborted (StrictMode's first mount)", async () => {
    controller.abort();
    const result = await registerPortalTools({ signal: controller.signal, guard: makeGuard() });

    expect(result.registered).toEqual([]);
    expect(modelContext.calls).toHaveLength(0);
    expect(modelContext.tools.size).toBe(0);
  });

  it("leaves a second mount with a live registration after the first is aborted", async () => {
    const first = new AbortController();
    await registerPortalTools({ signal: first.signal, guard: makeGuard() });
    const second = new AbortController();
    await registerPortalTools({ signal: second.signal, guard: makeGuard() });

    first.abort();

    // StrictMode double-mount: the surviving mount still owns all seven tools.
    expect(modelContext.tools.size).toBe(7);
    expect([...modelContext.tools.keys()].sort()).toEqual([...PORTAL_TOOL_NAMES].sort());
  });

  it("counts the tools the document exposes", async () => {
    await registerPortalTools({ signal: controller.signal, guard: makeGuard() });
    await expect(countRegisteredTools()).resolves.toBe(7);
  });
});

describe("registerPortalTools — legacy navigator surface", () => {
  it("registers through navigator.modelContext when document has none", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", {});
    defineGlobal("navigator", { modelContext });

    const controller = new AbortController();
    const result = await registerPortalTools({ signal: controller.signal, guard: makeGuard() });

    expect(result.surface).toBe("navigator");
    expect(result.registered).toEqual([...PORTAL_TOOL_NAMES]);
    expect(modelContext.tools.size).toBe(7);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });
});

describe("registerPortalTools — no WebMCP at all", () => {
  it("degrades quietly and warns exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await registerPortalTools({
      signal: new AbortController().signal,
      guard: makeGuard(),
    });
    const second = await registerPortalTools({
      signal: new AbortController().signal,
      guard: makeGuard(),
    });

    expect(first).toEqual({ surface: "unavailable", registered: [] });
    expect(second).toEqual({ surface: "unavailable", registered: [] });
    // The SDK owns the warning now — one per page load, not one per tool.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("chrome://flags/#enable-webmcp-testing");
    expect(WEBMCP_ENABLE_HINT).toContain("ChatGPT");
  });

  it("reports zero tools", async () => {
    await expect(countRegisteredTools()).resolves.toBe(0);
  });
});

describe("registered tool metadata", () => {
  it("matches the annotations docs/05 specifies", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
    await registerPortalTools({ signal: new AbortController().signal, guard: makeGuard() });

    const readOnly = (name: string) => modelContext.tools.get(name)?.annotations?.readOnlyHint;
    const untrusted = (name: string) =>
      modelContext.tools.get(name)?.annotations?.untrustedContentHint;

    for (const name of ["search_patients", "get_patient", "list_appointments", "export_patients"]) {
      expect(readOnly(name), `${name} should be read-only`).toBe(true);
    }
    for (const name of ["update_patient", "add_visit_note", "delete_patient"]) {
      expect(readOnly(name), `${name} should not be read-only`).toBe(false);
    }

    // Visit notes are clinician free text: the only tool that hands it back.
    expect(untrusted("get_patient")).toBe(true);
    expect(untrusted("search_patients")).toBe(false);
    expect(untrusted("delete_patient")).toBe(false);
  });

  it("does not leak the guard-only `tags` field into the WebMCP payload", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });
    await registerPortalTools({ signal: new AbortController().signal, guard: makeGuard() });

    // The SDK builds the browser-facing definition field by field; the portal no
    // longer needs a stripping layer of its own.
    for (const call of modelContext.calls) {
      expect(Object.keys(call.tool).sort()).toEqual([
        "annotations",
        "description",
        "execute",
        "inputSchema",
        "name",
      ]);
    }
  });

  it("gives every tool an agent-facing description and a JSON Schema", () => {
    for (const tool of createPortalTools()) {
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("carries the policy tags docs/05 assigns to each tool", () => {
    const tags = Object.fromEntries(createPortalTools().map((t) => [t.name, [...t.tags]]));

    expect(tags).toEqual({
      search_patients: ["read", "phi"],
      get_patient: ["read", "phi"],
      update_patient: ["write", "phi"],
      add_visit_note: ["write", "phi"],
      // Deviation from docs/05 (`read` only), argued at the definition: this
      // tool returns patientName and patientMrn, and without `phi` the seeded
      // transform rule never saw them.
      list_appointments: ["read", "phi"],
      export_patients: ["read", "phi", "bulk", "destructive-adjacent"],
      delete_patient: ["write", "destructive"],
    });
  });
});

describe("what the browser actually calls", () => {
  it("runs gate → execute → transform and reports the tags to the policy engine", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });

    const guard = guardFetchStub();
    // The portal's own API is stubbed too: this asserts the pipeline order, not
    // the repository (which `app/api/portal/routes.test.ts` covers).
    const portalFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, total: 1, patients: [{ mrn: "LM-100001" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await registerPortalTools({
      signal: new AbortController().signal,
      guard: makeGuard(guard.fetchImpl),
      context: { fetchImpl: portalFetch as unknown as typeof fetch },
    });

    const result = await modelContext.execute("search_patients", { text: "hypertension" });

    expect(guard.pipelineCalls.map((call) => call.url)).toEqual([
      "/api/guard/gate",
      "/api/guard/transform",
    ]);
    expect(guard.pipelineCalls[0].payload).toMatchObject({
      app: GUARD_APP,
      tool: "search_patients",
      args: { text: "hypertension" },
      toolTags: ["read", "phi"],
    });
    // The site's own execute ran, once, between the two round trips.
    expect(portalFetch).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("LM-100001");
  });

  it("returns the policy message and never runs the tool when the gate denies", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });

    const denial = "Deleting patient records from an agent is blocked by organization policy.";
    const guard = guardFetchStub({ verdict: "deny", message: denial });
    const portalFetch = vi.fn(async () => new Response("{}", { status: 200 }));

    await registerPortalTools({
      signal: new AbortController().signal,
      guard: makeGuard(guard.fetchImpl),
      context: { fetchImpl: portalFetch as unknown as typeof fetch },
    });

    const result = await modelContext.execute("delete_patient", { patient: "LM-100001" });

    expect(result).toBe(denial);
    expect(portalFetch).not.toHaveBeenCalled();
    // No transform round trip either: nothing ran, so there is no result.
    expect(guard.pipelineCalls.map((call) => call.url)).toEqual(["/api/guard/gate"]);
  });

  it("streams the pipeline to the Agent Activity drawer", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", { modelContext });

    const guard = guardFetchStub();
    const pageGuard = makeGuard(guard.fetchImpl);
    const seen: string[] = [];
    pageGuard.subscribe((event) => seen.push(event.type));

    await registerPortalTools({
      signal: new AbortController().signal,
      guard: pageGuard,
      context: {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: true, appointments: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    });

    await modelContext.execute("list_appointments", {});

    expect(seen).toEqual(["gate", "executed", "transformed"]);
    expect(pageGuard.recentEvents().map((event) => event.tool)).toEqual([
      "list_appointments",
      "list_appointments",
      "list_appointments",
    ]);
  });
});
