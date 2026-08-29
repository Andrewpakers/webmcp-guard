import type { GateVerdict, JsonObject, SessionContext } from "@webmcp-guard/shared";

import type { WebMcpExecuteContext, WebMcpSurface, WebMcpToolAnnotations } from "./webmcp";

/**
 * Public types for `@webmcp-guard/sdk`. The wire types (`GateRequest`,
 * `GateResponse`, `PostureSnapshot`, …) live in `@webmcp-guard/shared` and are
 * re-exported from `./index` so a host app needs exactly one import.
 */

/** Context the browser hands a tool's `execute`. May be absent — see below. */
export type GuardExecuteContext = WebMcpExecuteContext;

/** `annotations` as WebMCP defines them. */
export type GuardToolAnnotations = WebMcpToolAnnotations;

/**
 * A tool definition, as the *host page* writes it.
 *
 * Identical to a WebMCP tool plus `tags` — the guard-only field used for policy
 * matching (`{ tools: { tags: ["destructive"] } }` rules). `tags` is stripped
 * before the definition reaches the browser and travels to the server on the
 * gate request instead.
 *
 * `execute` is declared with method syntax so its parameters are checked
 * bivariantly: a host tool typed as `webmcp-types`' `ToolExecuteCallback`
 * (required `options` argument) assigns cleanly even though the guard calls it
 * with an optional context. That optionality is not theoretical — Chromium 151
 * invokes `execute(input)` with **no** second argument (see the Phase 1 entry in
 * `docs/07-development-plan.md`), so every implementation must tolerate it.
 */
export interface GuardToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: GuardToolAnnotations;
  /** WebMCP Guard policy tags, e.g. `["read", "phi"]`. Never sent to the browser. */
  tags?: readonly string[];
  execute(input: JsonObject, context?: GuardExecuteContext): unknown;
}

/** Options for `guard.registerTool`. */
export interface RegisterToolOptions {
  /**
   * Aborting this signal unregisters the tool, exactly as it does with raw
   * WebMCP. React effects should create one controller per mount and abort it
   * on cleanup; StrictMode's double mount is safe (an already-aborted signal
   * registers nothing).
   */
  signal?: AbortSignal;
}

/** What `guard.registerTool` reports back. Registration never throws. */
export interface RegistrationResult {
  tool: string;
  /** Which WebMCP entry point was used, or `"unavailable"`. */
  surface: WebMcpSurface;
  /** `false` when WebMCP is missing, the signal was already aborted, or the browser rejected the tool. */
  registered: boolean;
}

/** Everything `onBlocked` needs to render a toast. */
export interface BlockedInfo {
  tool: string;
  callId: string;
  verdict: GateVerdict;
  /** The agent-legible message the guard returned to the model. */
  message: string;
  /** Ids of the policy rules that produced the verdict, in match order. */
  ruleIds: string[];
}

/** Pipeline stages the Agent Activity drawer renders. */
export type GuardEventType = "gate" | "blocked" | "executed" | "transformed" | "error";

/**
 * One pipeline event. Page-local and human-facing: unlike the strings returned
 * to the agent, `detail` may carry raw failure reasons (HTTP status, thrown
 * message) because the human at the keyboard is already inside the trust
 * boundary.
 */
export interface GuardEvent {
  type: GuardEventType;
  tool: string;
  /** Server-issued call id, once the gate has answered. */
  callId?: string;
  verdict?: GateVerdict;
  /** ISO-8601 timestamp, client clock. */
  at: string;
  detail?: string;
}

export type GuardEventListener = (event: GuardEvent) => void;

/** Options for `createGuard`. */
export interface CreateGuardOptions {
  /** Where `@webmcp-guard/server` is mounted, e.g. `"/api/guard"`. */
  endpoint: string;
  /** App identifier used for policy scoping, e.g. `"lakeside-portal"`. */
  app: string;
  /**
   * Identity context for role-scoped policies. Called once per tool call;
   * throwing is tolerated (the call proceeds without session context).
   */
  getSessionContext?: () => SessionContext | undefined;
  /** UI hook fired on every non-allow verdict (toast, banner, …). */
  onBlocked?: (info: BlockedInfo) => void;
  /** Injectable `fetch`, for tests and for hosts with a wrapped transport. */
  fetchImpl?: typeof fetch;
}

/** The object `createGuard` returns. */
export interface Guard {
  /** Whether this browser exposes WebMCP. Re-detected on every read. */
  readonly available: boolean;
  /** Which surface was detected: `"document"`, `"navigator"`, or `"unavailable"`. */
  readonly surface: WebMcpSurface;
  /** Drop-in replacement for `modelContext.registerTool`. Never throws. */
  registerTool(
    definition: GuardToolDefinition,
    options?: RegisterToolOptions,
  ): Promise<RegistrationResult>;
  /** Subscribe to pipeline events. Returns an unsubscribe function. */
  subscribe(listener: GuardEventListener): () => void;
  /** The last {@link GUARD_EVENT_BUFFER_SIZE} events, oldest first. */
  recentEvents(): GuardEvent[];
}

/** How many events `recentEvents()` keeps, so a late-mounted drawer has history. */
export const GUARD_EVENT_BUFFER_SIZE = 50;
