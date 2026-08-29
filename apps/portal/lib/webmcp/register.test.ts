import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WEBMCP_ENABLE_HINT,
  countRegisteredTools,
  detectWebMcpSurface,
  registerPortalTools,
  resetWebMcpWarning,
  resolveModelContext,
} from "./register";
import { PORTAL_TOOL_NAMES, createPortalTools } from "./tools";

/**
 * These run in the node environment with a hand-rolled `modelContext` stub
 * rather than jsdom: WebMCP does not exist in jsdom either, so a stub is needed
 * regardless, and the registration code only touches two globals.
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

  it("registers all seven tools, in order", async () => {
    const result = await registerPortalTools({ signal: controller.signal });

    expect(result.surface).toBe("document");
    expect(result.registered).toEqual([...PORTAL_TOOL_NAMES]);
    expect(modelContext.calls.map((c) => c.tool.name)).toEqual([...PORTAL_TOOL_NAMES]);
    expect(modelContext.tools.size).toBe(7);
  });

  it("passes the abort signal on every registration", async () => {
    await registerPortalTools({ signal: controller.signal });
    for (const call of modelContext.calls) {
      expect(call.options?.signal).toBe(controller.signal);
    }
  });

  it("unregisters every tool when the signal aborts", async () => {
    await registerPortalTools({ signal: controller.signal });
    expect(modelContext.tools.size).toBe(7);

    controller.abort();
    expect(modelContext.tools.size).toBe(0);
  });

  it("registers nothing when the signal is already aborted (StrictMode's first mount)", async () => {
    controller.abort();
    const result = await registerPortalTools({ signal: controller.signal });

    expect(result.registered).toEqual([]);
    expect(modelContext.calls).toHaveLength(0);
    expect(modelContext.tools.size).toBe(0);
  });

  it("leaves a second mount with a live registration after the first is aborted", async () => {
    const first = new AbortController();
    await registerPortalTools({ signal: first.signal });
    const second = new AbortController();
    await registerPortalTools({ signal: second.signal });

    first.abort();

    // StrictMode double-mount: the surviving mount still owns all seven tools.
    expect(modelContext.tools.size).toBe(7);
    expect([...modelContext.tools.keys()].sort()).toEqual([...PORTAL_TOOL_NAMES].sort());
  });

  it("counts the tools the document exposes", async () => {
    await registerPortalTools({ signal: controller.signal });
    await expect(countRegisteredTools()).resolves.toBe(7);
  });
});

describe("registerPortalTools — legacy navigator surface", () => {
  it("registers through navigator.modelContext when document has none", async () => {
    const modelContext = new StubModelContext();
    defineGlobal("document", {});
    defineGlobal("navigator", { modelContext });

    const controller = new AbortController();
    const result = await registerPortalTools({ signal: controller.signal });

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

    const first = await registerPortalTools({ signal: new AbortController().signal });
    const second = await registerPortalTools({ signal: new AbortController().signal });

    expect(first).toEqual({ surface: "unavailable", registered: [] });
    expect(second).toEqual({ surface: "unavailable", registered: [] });
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
    await registerPortalTools({ signal: new AbortController().signal });

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
    await registerPortalTools({ signal: new AbortController().signal });

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
      list_appointments: ["read"],
      export_patients: ["read", "phi", "bulk", "destructive-adjacent"],
      delete_patient: ["write", "destructive"],
    });
  });
});
