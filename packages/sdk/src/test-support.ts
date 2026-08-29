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
  calls: FetchCall[];
  /** Calls to `${endpoint}/gate`, in order. */
  gateCalls: FetchCall[];
  transformCalls: FetchCall[];
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

/**
 * A `fetch` double that routes on the URL suffix and records every call.
 * A route may return a `Response` or throw to simulate a network failure.
 */
export function createFetchStub(routes: { gate?: FetchRoute; transform?: FetchRoute }): FetchStub {
  const calls: FetchCall[] = [];

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
  };
}

/** An `AbortError`, shaped the way `fetch` rejects. */
export function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
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
