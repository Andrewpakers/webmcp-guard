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

  it("passes the abort signal through, so aborting unregisters", async () => {
    const controller = new AbortController();
    await createGuard(guardOptions).registerTool(makeToolDefinition(), {
      signal: controller.signal,
    });

    expect(modelContext.lastCall?.options?.signal).toBe(controller.signal);
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
