import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGuard, resetWebMcpWarning } from "./index";
import { type ReactHooks, createUseGuardTool } from "./react";
import {
  StubModelContext,
  clearBrowserGlobals,
  defineGlobal,
  makeToolDefinition,
  restoreBrowserGlobals,
} from "./test-support";

/**
 * `react` is deliberately not a dependency of this package, so these tests run
 * against a ~40-line stand-in for React's effect lifecycle: render collects
 * effects, commit runs the ones whose deps changed, unmount runs cleanups.
 * That is exactly the contract `createUseGuardTool` relies on.
 */

interface CommittedEffect {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

function sameDeps(a?: readonly unknown[], b?: readonly unknown[]): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

class TestRenderer {
  private collected: Array<{ effect: () => void | (() => void); deps?: readonly unknown[] }> = [];
  private committed: CommittedEffect[] = [];

  readonly react: ReactHooks = {
    useEffect: (effect, deps) => {
      this.collected.push({ effect, deps });
    },
  };

  /** Renders and commits. `strict` re-runs the commit the way StrictMode does. */
  async render(component: () => void, options: { strict?: boolean } = {}): Promise<void> {
    this.collected = [];
    component();
    const collected = this.collected;

    collected.forEach((entry, index) => {
      const previous = this.committed[index];
      if (previous && sameDeps(previous.deps, entry.deps)) return;
      previous?.cleanup?.();
      const cleanup = entry.effect();
      this.committed[index] = {
        deps: entry.deps,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    });

    if (options.strict) {
      collected.forEach((entry, index) => {
        this.committed[index]?.cleanup?.();
        const cleanup = entry.effect();
        this.committed[index] = {
          deps: entry.deps,
          cleanup: typeof cleanup === "function" ? cleanup : undefined,
        };
      });
    }

    await flush();
  }

  async unmount(): Promise<void> {
    for (const entry of this.committed) entry.cleanup?.();
    this.committed = [];
    await flush();
  }
}

/** Lets the async `registerTool` settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let modelContext: StubModelContext;

beforeEach(() => {
  clearBrowserGlobals();
  resetWebMcpWarning();
  modelContext = new StubModelContext();
  defineGlobal("document", { modelContext });
});

afterEach(() => {
  restoreBrowserGlobals();
  vi.restoreAllMocks();
});

describe("createUseGuardTool", () => {
  const guardOptions = { endpoint: "/api/guard", app: "lakeside-portal" } as const;

  it("registers on mount and unregisters on unmount", async () => {
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);
    const definition = makeToolDefinition();

    await renderer.render(() => useGuardTool(guard, definition));
    expect(modelContext.tools.size).toBe(1);
    expect(modelContext.lastCall?.options?.signal).toBeInstanceOf(AbortSignal);

    await renderer.unmount();
    expect(modelContext.tools.size).toBe(0);
  });

  it("does not re-register while deps are unchanged", async () => {
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);

    // A fresh definition object each render, exactly like a real component.
    const render = () => renderer.render(() => useGuardTool(guard, makeToolDefinition(), [guard]));
    await render();
    await render();
    await render();

    expect(modelContext.calls).toHaveLength(1);
  });

  it("defaults to mount-only registration when no deps are given", async () => {
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);

    await renderer.render(() => useGuardTool(guard, makeToolDefinition()));
    await renderer.render(() => useGuardTool(guard, makeToolDefinition()));

    expect(modelContext.calls).toHaveLength(1);
  });

  it("re-registers when deps change, leaving exactly one live tool", async () => {
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);

    await renderer.render(() =>
      useGuardTool(guard, makeToolDefinition({ description: "v1" }), ["v1"]),
    );
    await renderer.render(() =>
      useGuardTool(guard, makeToolDefinition({ description: "v2" }), ["v2"]),
    );

    expect(modelContext.calls).toHaveLength(2);
    expect(modelContext.tools.size).toBe(1);
    expect(modelContext.tools.get("search_patients")?.description).toBe("v2");
  });

  it("leaves one live registration under StrictMode's double mount", async () => {
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);

    await renderer.render(() => useGuardTool(guard, makeToolDefinition(), [guard]), {
      strict: true,
    });

    expect(modelContext.tools.size).toBe(1);

    await renderer.unmount();
    expect(modelContext.tools.size).toBe(0);
  });

  it("is a no-op in a browser without WebMCP", async () => {
    clearBrowserGlobals();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renderer = new TestRenderer();
    const useGuardTool = createUseGuardTool(renderer.react);
    const guard = createGuard(guardOptions);

    await expect(
      renderer.render(() => useGuardTool(guard, makeToolDefinition())),
    ).resolves.toBeUndefined();
    await renderer.unmount();

    expect(warn).toHaveBeenCalledOnce();
  });
});
