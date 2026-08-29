import { WIRE_VERSION } from "@webmcp-guard/shared";

import type { GuardToolDefinition } from "./types";
import type { WebMcpRegisterToolOptions, WebMcpToolDefinition } from "./webmcp";

/**
 * Test-only helpers. Not exported from the package (`exports` maps `.` and
 * `./react` only) — they exist so the SDK's tests can run in the plain node
 * environment against hand-rolled globals.
 *
 * jsdom is not a dependency of this workspace, and it would not help anyway:
 * jsdom has no WebMCP, so a stub `modelContext` is required either way.
 */

interface RegisterCall {
  tool: WebMcpToolDefinition;
  options?: WebMcpRegisterToolOptions;
  live: boolean;
}

/**
 * Stands in for `document.modelContext` / `navigator.modelContext`.
 *
 * Registrations are tracked individually rather than by name, because that is
 * how the browser behaves: aborting one registration must not take down a later
 * registration of the same tool. React StrictMode produces exactly that
 * overlap, so the stub has to model it or the test proves nothing.
 */
export class StubModelContext {
  readonly calls: RegisterCall[] = [];
  /** When set, `registerTool` rejects with this error. */
  rejectWith?: Error;
  /** Rejects only the next N registrations, then behaves normally. */
  rejectNextCalls = 0;

  /** The tools currently exposed to an agent. */
  get tools(): Map<string, WebMcpToolDefinition> {
    const live = new Map<string, WebMcpToolDefinition>();
    for (const call of this.calls) {
      if (call.live) live.set(call.tool.name, call.tool);
    }
    return live;
  }

  /** The most recent registration, live or not. */
  get lastCall(): RegisterCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  registerTool(tool: WebMcpToolDefinition, options?: WebMcpRegisterToolOptions): Promise<void> {
    if (this.rejectWith) return Promise.reject(this.rejectWith);
    if (this.rejectNextCalls > 0) {
      this.rejectNextCalls -= 1;
      return Promise.reject(new Error("the browser rejected this registration"));
    }
    // Mirrors the real receiver requirement: a detached `registerTool` would
    // lose `this` and never record the call.
    if (!(this instanceof StubModelContext)) {
      return Promise.reject(new TypeError("Illegal invocation"));
    }

    const entry: RegisterCall = { tool, options, live: !options?.signal?.aborted };
    this.calls.push(entry);
    if (entry.live) {
      options?.signal?.addEventListener("abort", () => {
        entry.live = false;
      });
    }
    return Promise.resolve();
  }

  /** Invokes a live tool the way Chromium 151 does: input only, no context. */
  async executeToolWithoutContext(name: string, input?: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no live tool named ${name}`);
    return (tool.execute as (input?: unknown) => unknown)(input);
  }

  /** Invokes a live tool the way the spec documents: `(input, { signal })`. */
  async executeTool(name: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no live tool named ${name}`);
    return (tool.execute as (input: unknown, context: { signal?: AbortSignal }) => unknown)(input, {
      signal,
    });
  }
}

/* ---------------------------------------------------------------- globals -- */

const globalNames = [
  "document",
  "navigator",
  "isSecureContext",
  "innerWidth",
  "innerHeight",
] as const;

export type StubbableGlobal = (typeof globalNames)[number];

const originals = new Map<StubbableGlobal, PropertyDescriptor | undefined>();

export function defineGlobal(name: StubbableGlobal, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

export function removeGlobal(name: StubbableGlobal): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  delete (globalThis as Record<string, unknown>)[name];
}

/** No WebMCP and no browser globals — the baseline every test starts from. */
export function clearBrowserGlobals(): void {
  for (const name of globalNames) removeGlobal(name);
}

/** Puts back whatever node had before the test touched it. */
export function restoreBrowserGlobals(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
  originals.clear();
}

/* ------------------------------------------------------------------ fetch -- */

export interface FetchCall {
  url: string;
  init: RequestInit;
  /** The decoded request envelope. */
  envelope: { version?: unknown; payload?: unknown };
  /** Shorthand for `envelope.payload`. */
  payload: Record<string, unknown>;
  signal?: AbortSignal | null;
}

export type FetchRoute = (call: FetchCall) => Response | Promise<Response>;

export interface FetchStub {
  fetchImpl: typeof fetch;
  /** Every request the SDK made, registration policy reads included. */
  calls: FetchCall[];
  /** Calls to `${endpoint}/gate`, in order. */
  gateCalls: FetchCall[];
  transformCalls: FetchCall[];
  /** Registration-time `${endpoint}/policies/effective` reads. */
  policyCalls: FetchCall[];
  /** Gate + transform only: the round trips one tool call makes. */
  pipelineCalls: FetchCall[];
}

/** JSON body wrapped in the versioned envelope, with an overridable version. */
export function envelopeResponse(
  payload: unknown,
  init: { status?: number; version?: number } = {},
): Response {
  return new Response(JSON.stringify({ version: init.version ?? WIRE_VERSION, payload }), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

/** What `GET /policies/effective` answers when a test does not say otherwise. */
export function effectivePolicyResponse(
  overrides: Partial<{
    requiresJustification: boolean;
    minChars: number | null;
    requiresConfirmation: boolean;
    disabled: boolean;
  }> = {},
): Response {
  return envelopeResponse({
    requiresJustification: false,
    minChars: null,
    requiresConfirmation: false,
    disabled: false,
    ...overrides,
  });
}

/**
 * A `fetch` double that routes on the URL and records every call.
 * A route may return a `Response` or throw to simulate a network failure.
 *
 * `policies` defaults to "nothing special about this tool", so a test that only
 * cares about the pipeline does not have to describe registration policy.
 */
export function createFetchStub(routes: {
  gate?: FetchRoute;
  transform?: FetchRoute;
  policies?: FetchRoute;
}): FetchStub {
  const calls: FetchCall[] = [];
  const isPolicyCall = (url: string) => url.includes("/policies/effective");

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "{}";
    const envelope = JSON.parse(body) as { version?: unknown; payload?: unknown };
    const call: FetchCall = {
      url,
      init: init ?? {},
      envelope,
      payload: (envelope.payload ?? {}) as Record<string, unknown>,
      signal: init?.signal,
    };
    calls.push(call);

    const route = url.endsWith("/gate")
      ? routes.gate
      : url.endsWith("/transform")
        ? routes.transform
        : isPolicyCall(url)
          ? (routes.policies ?? (() => effectivePolicyResponse()))
          : undefined;
    if (!route) throw new Error(`unexpected fetch to ${url}`);
    return route(call);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    get gateCalls() {
      return calls.filter((call) => call.url.endsWith("/gate"));
    },
    get transformCalls() {
      return calls.filter((call) => call.url.endsWith("/transform"));
    },
    get policyCalls() {
      return calls.filter((call) => isPolicyCall(call.url));
    },
    get pipelineCalls() {
      return calls.filter((call) => !isPolicyCall(call.url));
    },
  };
}

/** An `AbortError`, shaped the way `fetch` rejects. */
export function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/* --------------------------------------------------------------- fake DOM -- */

/**
 * The smallest DOM the confirmation modal actually uses.
 *
 * jsdom is not a dependency of this workspace, and pulling it in for one dialog
 * would be a heavier lie than this: the modal touches `createElement`,
 * `appendChild`, `setAttribute`, `textContent`, `style.cssText`, `remove`,
 * `focus` and two event listeners, and every one of those is modelled here
 * exactly as the browser behaves. The real thing is driven for real by the
 * headless-Chromium e2e run.
 */
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  style = { cssText: "" };
  textContent: string | null = null;
  /** True once `remove()` was called — the browser would have unlinked it. */
  removed = false;
  focused = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  remove(): void {
    this.removed = true;
  }

  focus(): void {
    this.focused = true;
  }

  /** Fires every listener for `type`, the way a real click would. */
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  click(): void {
    this.dispatch("click");
  }

  /** Depth-first search by `data-testid`, ignoring removed subtrees. */
  find(testId: string): FakeElement | null {
    if (this.removed) return null;
    if (this.attributes.get("data-testid") === testId) return this;
    for (const child of this.children) {
      const found = child.find(testId);
      if (found) return found;
    }
    return null;
  }

  /** Every element in this subtree, removed ones included. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export class FakeDocument {
  readonly body = new FakeElement("body");
  private readonly listeners = new Map<string, Set<(event: { key?: string }) => void>>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(type: string, listener: (event: { key?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { key?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Simulates a keypress reaching the document. */
  press(key: string): void {
    for (const listener of [...(this.listeners.get("keydown") ?? [])]) listener({ key });
  }

  /** How many `keydown` listeners are still attached — leak detection. */
  get keydownListeners(): number {
    return this.listeners.get("keydown")?.size ?? 0;
  }

  find(testId: string): FakeElement | null {
    return this.body.find(testId);
  }
}

/* ------------------------------------------------------------------ tools -- */

/** A minimal, valid tool definition; override any field. */
export function makeToolDefinition(
  overrides: Partial<GuardToolDefinition> = {},
): GuardToolDefinition {
  return {
    name: "search_patients",
    description: "Searches the patient roster.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
    tags: ["read", "phi"],
    execute: () => "raw-result",
    ...overrides,
  };
}
