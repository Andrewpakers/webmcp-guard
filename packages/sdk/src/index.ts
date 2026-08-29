import { GuardEventHub, guardEvent } from "./events";
import { WEBMCP_UNAVAILABLE_WARNING } from "./messages";
import { type PipelineConfig, createGuardedExecute } from "./pipeline";
import { normalizeEndpoint } from "./transport";
import {
  type CreateGuardOptions,
  type Guard,
  type GuardEventListener,
  type GuardToolDefinition,
  type RegisterToolOptions,
  type RegistrationResult,
} from "./types";
import {
  type WebMcpToolDefinition,
  detectWebMcpSurface,
  registerWithDocument,
  registerWithNavigator,
  resolveDocumentHost,
  resolveNavigatorHost,
} from "./webmcp";

/**
 * `@webmcp-guard/sdk` — the browser half of WebMCP Guard.
 *
 * Wraps a site's WebMCP tools so every agent call runs through the guard
 * pipeline (gate → execute → transform) before a result ever reaches the model.
 * The literal `document.modelContext.registerTool(` call the challenge requires
 * lives in `./webmcp.ts`.
 *
 * Honest scope (`docs/03` threat model): this wrapper governs the *agent
 * channel*. It is not a sandbox around the page and it is not a boundary
 * against the human at the keyboard — enforcement of anything secret
 * (detokenization, policy, logging) is server-side in `@webmcp-guard/server`.
 */
export const PACKAGE_NAME = "@webmcp-guard/sdk" as const;

/**
 * Warn-once state (`docs/04` behavior 2). Module scope is page scope: a site
 * with several guards still logs one warning per page load.
 */
let hasWarnedNoWebMcp = false;

/** Test seam: lets a test observe the once-only warning more than once. */
export function resetWebMcpWarning(): void {
  hasWarnedNoWebMcp = false;
}

function warnWebMcpUnavailableOnce(): void {
  if (hasWarnedNoWebMcp) return;
  hasWarnedNoWebMcp = true;
  console.warn(WEBMCP_UNAVAILABLE_WARNING);
}

/**
 * Builds the definition the *browser* sees.
 *
 * Field-by-field on purpose: guard-only fields (`tags`) must not leak into the
 * WebMCP payload, and an unknown field a host happens to hang off its
 * definition should not silently become part of the tool the agent discovers.
 */
function toBrowserTool(
  definition: GuardToolDefinition,
  execute: WebMcpToolDefinition["execute"],
): WebMcpToolDefinition {
  const tool: WebMcpToolDefinition = {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute,
  };
  if (definition.annotations) tool.annotations = { ...definition.annotations };
  return tool;
}

/**
 * Creates a guard bound to one app and one mounted guard server.
 *
 * Throws only for a misconfigured call (missing `endpoint` / `app`) — a
 * programmer error worth surfacing loudly at startup. It never throws because
 * of the browser: a browser without WebMCP produces `available === false` and
 * no-op registrations, per `docs/04` behavior 2.
 */
export function createGuard(options: CreateGuardOptions): Guard {
  if (typeof options?.endpoint !== "string" || options.endpoint.trim() === "") {
    throw new TypeError('createGuard: `endpoint` is required, e.g. "/api/guard".');
  }
  if (typeof options.app !== "string" || options.app.trim() === "") {
    throw new TypeError('createGuard: `app` is required, e.g. "lakeside-portal".');
  }

  const events = new GuardEventHub();
  const config: PipelineConfig = {
    app: options.app,
    endpoint: normalizeEndpoint(options.endpoint),
    // Resolved at call time and invoked as a method of the global so browsers
    // do not reject a detached `fetch`.
    fetchImpl: options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    getSessionContext: options.getSessionContext,
    onBlocked: options.onBlocked,
    events,
  };

  async function registerTool(
    definition: GuardToolDefinition,
    registerOptions: RegisterToolOptions = {},
  ): Promise<RegistrationResult> {
    const signal = registerOptions.signal;
    const surface = detectWebMcpSurface();

    if (surface === "unavailable") {
      warnWebMcpUnavailableOnce();
      return { tool: definition.name, surface, registered: false };
    }

    // An already-aborted signal means the caller is gone (React StrictMode
    // tears down the first mount before the second one runs). Registering
    // against a dead signal would leak a tool the browser never unregisters.
    if (signal?.aborted) {
      return { tool: definition.name, surface, registered: false };
    }

    const tool = toBrowserTool(definition, createGuardedExecute(config, definition));

    try {
      const documentHost = resolveDocumentHost();
      if (documentHost) {
        await registerWithDocument(documentHost, tool, { signal });
        return { tool: definition.name, surface: "document", registered: true };
      }

      const navigatorHost = resolveNavigatorHost();
      if (navigatorHost) {
        await registerWithNavigator(navigatorHost, tool, { signal });
        return { tool: definition.name, surface: "navigator", registered: true };
      }
    } catch (error) {
      // The browser rejected the definition (bad name, bad schema, …). Report
      // it where a developer and the Agent Activity drawer can both see it, but
      // never let a registration failure take down the host page.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[WebMCP Guard] registering "${definition.name}" failed:`, error);
      events.emit(guardEvent("error", definition.name, { detail: `register: ${detail}` }));
      return { tool: definition.name, surface, registered: false };
    }

    // WebMCP disappeared between detection and registration.
    warnWebMcpUnavailableOnce();
    return { tool: definition.name, surface: "unavailable", registered: false };
  }

  return {
    get available() {
      return detectWebMcpSurface() !== "unavailable";
    },
    get surface() {
      return detectWebMcpSurface();
    },
    registerTool,
    subscribe(listener: GuardEventListener) {
      return events.subscribe(listener);
    },
    recentEvents() {
      return events.recent();
    },
  };
}

export {
  BLOCKED_FALLBACK_MESSAGE,
  CANCELLED_MESSAGE,
  EMPTY_RESULT_MESSAGE,
  WEBMCP_UNAVAILABLE_WARNING,
  executeFailedMessage,
  invalidArgumentsMessage,
  verificationFailedMessage,
  type GuardStage,
} from "./messages";
export { collectPostureSnapshot } from "./posture";
export { detectWebMcpSurface } from "./webmcp";
export type { WebMcpSurface } from "./webmcp";
export {
  GUARD_EVENT_BUFFER_SIZE,
  type BlockedInfo,
  type CreateGuardOptions,
  type Guard,
  type GuardEvent,
  type GuardEventListener,
  type GuardEventType,
  type GuardExecuteContext,
  type GuardToolAnnotations,
  type GuardToolDefinition,
  type RegisterToolOptions,
  type RegistrationResult,
} from "./types";
/** Re-exported so a host app needs one import for the whole public surface. */
export type { GateVerdict, PostureSnapshot, SessionContext } from "@webmcp-guard/shared";
