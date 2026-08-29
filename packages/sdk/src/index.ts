import type { EffectivePolicy } from "@webmcp-guard/shared";

import { defaultConfirmationHandler } from "./confirmation";
import { GuardEventHub, guardEvent } from "./events";
import { WEBMCP_UNAVAILABLE_WARNING } from "./messages";
import { type PipelineConfig, createGuardedExecute } from "./pipeline";
import { applyPolicyToSchema, schemaSignature } from "./schema";
import { getEffectivePolicy, normalizeEndpoint } from "./transport";
import {
  POLICY_REFRESH_INTERVAL_MS,
  type CreateGuardOptions,
  type Guard,
  type GuardEventListener,
  type GuardToolDefinition,
  type RegisterToolOptions,
  type RegistrationResult,
} from "./types";
import {
  type WebMcpSurface,
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
 *
 * `inputSchema` is the policy-rewritten **copy** from `applyPolicyToSchema`,
 * never the host's own object.
 */
function toBrowserTool(
  definition: GuardToolDefinition,
  execute: WebMcpToolDefinition["execute"],
  inputSchema: Record<string, unknown>,
): WebMcpToolDefinition {
  const tool: WebMcpToolDefinition = {
    name: definition.name,
    description: definition.description,
    inputSchema,
    execute,
  };
  if (definition.annotations) tool.annotations = { ...definition.annotations };
  return tool;
}

/**
 * One live registration. The guard owns an `AbortController` per tool rather
 * than passing the host's signal straight through, because re-registering on a
 * policy change means *unregistering first* (`docs/08`: "re-registration on
 * policy change = abort old registration, register the new definition") and the
 * host's signal is not the guard's to abort.
 */
interface Registration {
  definition: GuardToolDefinition;
  /** The signal the host gave `registerTool`, if any. */
  hostSignal?: AbortSignal;
  /** Aborting this unregisters the tool from the browser. */
  controller: AbortController;
  /** Effective policy the current registration was built from. */
  policy: EffectivePolicy | null;
  /** Detaches the host-signal listener when this registration is dropped. */
  release: () => void;
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
    confirmationHandler: options.confirmationHandler ?? defaultConfirmationHandler,
    events,
  };

  const registrations = new Set<Registration>();
  const refreshMs = options.policyRefreshMs ?? POLICY_REFRESH_INTERVAL_MS;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** The refresh pass currently running, so two never overlap. */
  let refreshInFlight: Promise<number> | null = null;

  /**
   * Reads effective policy for one tool. `null` means "the guard did not
   * answer" — which is *not* the same as "no policy", and is why every caller
   * treats it as "leave the schema alone" rather than "no justification
   * needed".
   */
  async function readPolicy(
    definition: GuardToolDefinition,
    signal?: AbortSignal,
  ): Promise<EffectivePolicy | null> {
    try {
      return await getEffectivePolicy(
        config,
        {
          app: config.app,
          tool: definition.name,
          ...(definition.tags?.length ? { tags: [...definition.tags] } : {}),
        },
        signal,
      );
    } catch {
      // Aborts are the only thing `getEffectivePolicy` rethrows, and an aborted
      // registration is about to be discarded anyway.
      return null;
    }
  }

  /** Hands the browser one tool definition, built from `policy`. */
  async function register(
    definition: GuardToolDefinition,
    policy: EffectivePolicy | null,
    signal: AbortSignal,
  ): Promise<WebMcpSurface | null> {
    const tool = toBrowserTool(
      definition,
      createGuardedExecute(config, definition),
      applyPolicyToSchema(definition.inputSchema, policy),
    );

    const documentHost = resolveDocumentHost();
    if (documentHost) {
      await registerWithDocument(documentHost, tool, { signal });
      return "document";
    }

    const navigatorHost = resolveNavigatorHost();
    if (navigatorHost) {
      await registerWithNavigator(navigatorHost, tool, { signal });
      return "navigator";
    }

    return null;
  }

  function startRefreshTimer(): void {
    if (refreshTimer !== null || refreshMs <= 0) return;
    refreshTimer = setInterval(() => {
      void refreshPolicies();
    }, refreshMs);
    // One timer for every tool, and never a reason to keep a process alive.
    (refreshTimer as { unref?: () => void }).unref?.();
  }

  function stopRefreshTimerIfIdle(): void {
    if (refreshTimer === null || registrations.size > 0) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function drop(entry: Registration): void {
    entry.release();
    registrations.delete(entry);
    stopRefreshTimerIfIdle();
  }

  /** Wires a fresh controller to the host's signal, so aborting still works. */
  function track(definition: GuardToolDefinition, hostSignal?: AbortSignal): Registration {
    const controller = new AbortController();
    const entry: Registration = {
      definition,
      ...(hostSignal ? { hostSignal } : {}),
      controller,
      policy: null,
      release: () => {},
    };

    if (hostSignal) {
      const onAbort = () => {
        // `entry.controller`, not the one captured above: a re-registration
        // swaps it, and aborting a spent controller would leak the live tool.
        entry.controller.abort();
        drop(entry);
      };
      hostSignal.addEventListener("abort", onAbort, { once: true });
      entry.release = () => hostSignal.removeEventListener("abort", onAbort);
    }

    return entry;
  }

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

    // Policy first: the schema an agent discovers has to be the right one from
    // the very first registration, not one tool call later.
    const policy = await readPolicy(definition, signal);
    if (signal?.aborted) return { tool: definition.name, surface, registered: false };

    const entry = track(definition, signal);
    entry.policy = policy;

    try {
      const used = await register(definition, policy, entry.controller.signal);
      if (used !== null) {
        registrations.add(entry);
        startRefreshTimer();
        return { tool: definition.name, surface: used, registered: true };
      }
    } catch (error) {
      // The browser rejected the definition (bad name, bad schema, …). Report
      // it where a developer and the Agent Activity drawer can both see it, but
      // never let a registration failure take down the host page.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[WebMCP Guard] registering "${definition.name}" failed:`, error);
      events.emit(guardEvent("error", definition.name, { detail: `register: ${detail}` }));
      entry.release();
      return { tool: definition.name, surface, registered: false };
    }

    // WebMCP disappeared between detection and registration.
    entry.release();
    warnWebMcpUnavailableOnce();
    return { tool: definition.name, surface: "unavailable", registered: false };
  }

  /**
   * Re-reads effective policy for every live tool and re-registers the ones
   * whose input schema changed (`docs/04` behavior 3, `docs/08` re-registration
   * = abort + register).
   *
   * Only a *schema* change triggers a re-registration. A policy that starts
   * requiring confirmation changes nothing an agent can see in the tool list,
   * and churning every registration on it would fire `toolchange` events at
   * agents for no reason.
   */
  async function refreshPolicies(): Promise<number> {
    // A refresh walks every tool with an HTTP round trip each, so a slow guard
    // server could otherwise have the timer start a second pass over the same
    // registrations — two passes both deciding to re-register would churn the
    // browser's tool list for no reason. Callers share the pass in flight.
    refreshInFlight ??= runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function runRefresh(): Promise<number> {
    let rebuilt = 0;

    for (const entry of [...registrations]) {
      if (entry.hostSignal?.aborted) {
        drop(entry);
        continue;
      }

      const policy = await readPolicy(entry.definition);
      // No answer: keep whatever is registered. A guard server that is briefly
      // unreachable must not silently strip a required justification field.
      if (policy === null) continue;
      if (schemaSignature(policy) === schemaSignature(entry.policy)) {
        entry.policy = policy;
        continue;
      }

      /**
       * **Unregister first, then register** — `docs/08`: "re-registration on
       * policy change = abort old registration, register the new definition".
       *
       * Not a stylistic choice: Chromium 151 keeps the *existing* tool when a
       * name that is already registered is registered again, so building the
       * replacement first leaves the page showing the stale schema forever
       * (observed in the headless e2e run before this was fixed). The cost is a
       * sub-millisecond window with the tool absent, which is why the failure
       * path below puts the previous definition back.
       */
      const previous = entry.policy;
      entry.controller.abort();

      const controller = new AbortController();
      try {
        const used = await register(entry.definition, policy, controller.signal);
        if (used === null) {
          // WebMCP vanished; there is nothing to re-register against.
          drop(entry);
          continue;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        events.emit(
          guardEvent("error", entry.definition.name, { detail: `re-register: ${detail}` }),
        );

        // The old registration is already gone. Put it back rather than leaving
        // the page one tool short because a policy read produced a schema the
        // browser did not like.
        try {
          const restored = new AbortController();
          if ((await register(entry.definition, previous, restored.signal)) !== null) {
            entry.controller = restored;
            continue;
          }
        } catch {
          // Nothing left to try.
        }
        drop(entry);
        continue;
      }

      entry.controller = controller;
      entry.policy = policy;
      rebuilt += 1;
      events.emit(
        guardEvent("gate", entry.definition.name, {
          detail: "Policy changed; the tool was re-registered with a new input schema.",
        }),
      );
    }

    return rebuilt;
  }

  return {
    get available() {
      return detectWebMcpSurface() !== "unavailable";
    },
    get surface() {
      return detectWebMcpSurface();
    },
    registerTool,
    refreshPolicies,
    subscribe(listener: GuardEventListener) {
      return events.subscribe(listener);
    },
    recentEvents() {
      return events.recent();
    },
  };
}

export {
  APPROVAL_NOT_ACCEPTED_MESSAGE,
  BLOCKED_FALLBACK_MESSAGE,
  CANCELLED_MESSAGE,
  CONFIRMATION_UNAVAILABLE_MESSAGE,
  EMPTY_RESULT_MESSAGE,
  WEBMCP_UNAVAILABLE_WARNING,
  declinedMessage,
  executeFailedMessage,
  invalidArgumentsMessage,
  verificationFailedMessage,
  type GuardStage,
} from "./messages";
export {
  CONFIRMATION_TEST_IDS,
  defaultConfirmationHandler,
  formatConfirmationArgs,
  type ConfirmationDecision,
  type ConfirmationHandler,
  type ConfirmationRequest,
} from "./confirmation";
export { AGENT_UA_MARKERS, collectPostureSnapshot, guessAgentId } from "./posture";
export {
  JUSTIFICATION_PROPERTY,
  applyPolicyToSchema,
  justificationDescription,
  schemaSignature,
} from "./schema";
export { detectWebMcpSurface } from "./webmcp";
export type { WebMcpSurface } from "./webmcp";
export {
  GUARD_EVENT_BUFFER_SIZE,
  POLICY_REFRESH_INTERVAL_MS,
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
export type {
  EffectivePolicy,
  GateVerdict,
  PostureSnapshot,
  SessionContext,
} from "@webmcp-guard/shared";
