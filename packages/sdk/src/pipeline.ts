import type {
  GateRequest,
  GateResponse,
  JsonObject,
  SessionContext,
  TransformResponse,
} from "@webmcp-guard/shared";

import { isAbortError } from "./abort";
import type { ConfirmationDecision, ConfirmationHandler } from "./confirmation";
import { type GuardEventHub, guardEvent } from "./events";
import {
  APPROVAL_NOT_ACCEPTED_MESSAGE,
  BLOCKED_FALLBACK_MESSAGE,
  CANCELLED_MESSAGE,
  CONFIRMATION_UNAVAILABLE_MESSAGE,
  EMPTY_RESULT_MESSAGE,
  declinedMessage,
  executeFailedMessage,
  invalidArgumentsMessage,
  verificationFailedMessage,
} from "./messages";
import { collectPostureSnapshot } from "./posture";
import { GuardStageError, type TransportConfig, postGate, postTransform } from "./transport";
import type { BlockedInfo, GuardExecuteContext, GuardToolDefinition } from "./types";

/**
 * The execute pipeline: **gate → (confirm) → execute → transform**, in that
 * order, with fail-closed semantics at every step (`docs/03` data flow,
 * `docs/04` behavior 4).
 *
 * The invariants a reviewer should hold this file to:
 *
 *  0. A `require-confirmation` verdict is only ever turned into a call by a
 *     *second* gate round trip carrying the one-time id the guard issued, and
 *     only after a human decision. Declining, cancelling, a handler that
 *     throws, and a missing id all stop the call.
 *  1. The site's `execute` runs **only** after a validated `allow` verdict.
 *  2. A raw, untransformed result never reaches the agent. If `/transform`
 *     cannot be reached or answers with something the SDK does not trust, the
 *     result is dropped and the agent gets a withheld-result message.
 *  3. Everything returned to the agent is a string of actionable prose — no
 *     stack traces, no HTTP statuses, no internal state (`docs/04` behavior 6).
 *     Raw failure detail goes to the page-local event stream instead, where the
 *     human (who is already inside the trust boundary) can see it.
 *  4. Cancellation stops the pipeline cleanly and is reported as cancellation,
 *     not as a failure.
 */

export interface PipelineConfig extends TransportConfig {
  app: string;
  getSessionContext?: () => SessionContext | undefined;
  onBlocked?: (info: BlockedInfo) => void;
  events: GuardEventHub;
  /** Asks the person at the keyboard to approve a `require-confirmation` call. */
  confirmationHandler: ConfirmationHandler;
}

/** The shape the browser actually invokes: input only, context only sometimes. */
export type GuardedExecute = (input?: unknown, context?: GuardExecuteContext) => Promise<string>;

/**
 * Tool arguments must be a JSON object to cross the wire (and to be classified
 * server-side). Missing input is an empty object; anything else is refused
 * rather than silently coerced to `{}`, which would hand the gate a different
 * call from the one the agent asked for.
 */
function normalizeArgs(input: unknown): JsonObject | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;
  return input as JsonObject;
}

/**
 * The host's `getSessionContext` is application code: it may throw, and it may
 * hand back extra fields. `SessionContextSchema` is strict, so anything beyond
 * `{ userId, role }` would make the server reject the whole request — copy the
 * two known fields instead of trusting the object wholesale.
 */
function readSessionContext(
  getSessionContext: (() => SessionContext | undefined) | undefined,
): SessionContext | undefined {
  if (!getSessionContext) return undefined;
  let raw: SessionContext | undefined;
  try {
    raw = getSessionContext();
  } catch (error) {
    console.warn("[WebMCP Guard] getSessionContext threw; continuing without it:", error);
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const context: SessionContext = {};
  if (typeof raw.userId === "string") context.userId = raw.userId;
  if (typeof raw.role === "string") context.role = raw.role;
  return context.userId === undefined && context.role === undefined ? undefined : context;
}

/** Agents consume text. Objects are JSON; `undefined` gets a plain-English note. */
function toAgentString(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return EMPTY_RESULT_MESSAGE;
  try {
    return JSON.stringify(result) ?? EMPTY_RESULT_MESSAGE;
  } catch {
    // Unserializable means the guard cannot show it to the agent verbatim, and
    // guessing at a rendering would be worse than admitting the failure.
    return verificationFailedMessage("transform");
  }
}

function describe(error: unknown): string {
  if (error instanceof GuardStageError) return error.reason;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wraps one tool definition's `execute` with the guard pipeline. The returned
 * function is what the browser (and therefore the agent) actually calls; it
 * resolves with a string in every path and rejects in none.
 */
export function createGuardedExecute(
  config: PipelineConfig,
  definition: GuardToolDefinition,
): GuardedExecute {
  const tool = definition.name;
  const tags = definition.tags?.length ? [...definition.tags] : undefined;

  return async function guardedExecute(input?: unknown, context?: GuardExecuteContext) {
    // Chromium 151 calls `execute(input)` with no second argument even though
    // the spec says `(input, { signal })` — `context` is genuinely optional.
    const signal = context?.signal;
    const emit = config.events.emit.bind(config.events);

    if (signal?.aborted) {
      emit(guardEvent("error", tool, { detail: "cancelled before the gate call" }));
      return CANCELLED_MESSAGE;
    }

    const args = normalizeArgs(input);
    if (args === null) {
      emit(guardEvent("error", tool, { detail: "arguments were not a JSON object" }));
      return invalidArgumentsMessage(tool);
    }

    // ---- 1. Gate -----------------------------------------------------------
    const request: GateRequest = {
      app: config.app,
      tool,
      args,
      posture: collectPostureSnapshot(),
    };
    if (tags) request.toolTags = tags;
    const sessionContext = readSessionContext(config.getSessionContext);
    if (sessionContext) request.sessionContext = sessionContext;

    /** One gate round trip, plus the event the drawer renders for it. */
    async function callGate(payload: GateRequest): Promise<GateResponse> {
      const response = await postGate(config, payload, signal);
      emit(
        guardEvent("gate", tool, {
          callId: response.callId,
          verdict: response.verdict,
          ...(response.message ? { detail: response.message } : {}),
        }),
      );
      return response;
    }

    let gate: GateResponse;
    try {
      gate = await callGate(request);
    } catch (error) {
      if (isAbortError(error, signal)) {
        emit(guardEvent("error", tool, { detail: "cancelled during the gate call" }));
        return CANCELLED_MESSAGE;
      }
      emit(guardEvent("error", tool, { detail: `gate: ${describe(error)}` }));
      return verificationFailedMessage("gate");
    }

    // ---- 2. Human confirmation --------------------------------------------
    /**
     * `require-confirmation` is the one verdict that is a *question*, not an
     * answer: the guard hands back a one-time id, the SDK asks the person at
     * the keyboard, and — only on approval — re-issues the identical gate call
     * carrying that id. The second answer is the real verdict.
     *
     * Exactly one round of this happens. If the second gate call somehow asks
     * for confirmation again, it falls through to the blocked path below rather
     * than looping: an agent must never be able to drive a modal storm.
     */
    if (gate.verdict === "require-confirmation" && gate.confirmationId !== undefined) {
      const confirmationId = gate.confirmationId;
      let decision: ConfirmationDecision;

      try {
        decision = await config.confirmationHandler({
          app: config.app,
          tool,
          message: gate.message ?? BLOCKED_FALLBACK_MESSAGE,
          args,
          callId: gate.callId,
          confirmationId,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // A broken approval UI is not an approval.
        emit(
          guardEvent("error", tool, {
            callId: gate.callId,
            detail: `confirmation: ${describe(error)}`,
          }),
        );
        decision = "declined";
      }

      emit(
        guardEvent("confirmation", tool, {
          callId: gate.callId,
          verdict: gate.verdict,
          decision,
          detail:
            decision === "approved"
              ? "The person using this page approved the call."
              : decision === "declined"
                ? "The person using this page declined the call."
                : "The call was cancelled before anyone could answer.",
        }),
      );

      if (signal?.aborted || decision === "cancelled") return CANCELLED_MESSAGE;

      if (decision === "approved") {
        try {
          gate = await callGate({ ...request, confirmationId });
        } catch (error) {
          if (isAbortError(error, signal)) {
            emit(guardEvent("error", tool, { detail: "cancelled during the gate call" }));
            return CANCELLED_MESSAGE;
          }
          emit(guardEvent("error", tool, { detail: `gate: ${describe(error)}` }));
          return verificationFailedMessage("gate");
        }

        // The approval was spent but the guard still refused (expired while the
        // modal was open, arguments changed, policy moved). Say so plainly.
        if (gate.verdict !== "allow" && gate.message === undefined) {
          gate = { ...gate, message: APPROVAL_NOT_ACCEPTED_MESSAGE };
        }
      } else {
        // Declined. The agent gets the policy's own explanation plus the one
        // fact it most needs: a person said no.
        gate = { ...gate, message: declinedMessage(gate.message) };
      }
    }

    // ---- 3. Verdict --------------------------------------------------------
    if (gate.verdict !== "allow") {
      // Everything that is not a plain `allow` stops the call. Fail closed.
      // A `require-confirmation` that reaches here had no confirmation id to
      // work with, so there was nothing for anyone to approve.
      const message =
        gate.message ??
        (gate.verdict === "require-confirmation"
          ? CONFIRMATION_UNAVAILABLE_MESSAGE
          : BLOCKED_FALLBACK_MESSAGE);
      emit(
        guardEvent("blocked", tool, {
          callId: gate.callId,
          verdict: gate.verdict,
          detail: message,
        }),
      );
      const info: BlockedInfo = {
        tool,
        callId: gate.callId,
        verdict: gate.verdict,
        message,
        ruleIds: gate.ruleIds,
      };
      try {
        config.onBlocked?.(info);
      } catch (error) {
        console.error("[WebMCP Guard] onBlocked threw:", error);
      }
      return message;
    }

    // ---- 4. The site's own execute, in the page ----------------------------
    let result: unknown;
    try {
      // Detokenized args from the gate when it supplied them, the agent's own
      // arguments otherwise. The context object is forwarded verbatim when the
      // browser gave one, and omitted entirely when it did not, so the site
      // sees exactly what raw WebMCP would have handed it.
      const executeArgs = gate.args ?? args;
      result = context
        ? await definition.execute(executeArgs, context)
        : await definition.execute(executeArgs);
    } catch (error) {
      if (isAbortError(error, signal)) {
        emit(guardEvent("error", tool, { callId: gate.callId, detail: "cancelled while running" }));
        return CANCELLED_MESSAGE;
      }
      emit(
        guardEvent("error", tool, { callId: gate.callId, detail: `execute: ${describe(error)}` }),
      );
      return executeFailedMessage(tool);
    }
    emit(guardEvent("executed", tool, { callId: gate.callId, verdict: gate.verdict }));

    // ---- 5. Transform ------------------------------------------------------
    let transformed: TransformResponse;
    try {
      transformed = await postTransform(
        config,
        { app: config.app, tool, callId: gate.callId, result },
        signal,
      );
    } catch (error) {
      // The raw result exists in this closure and must die here: it has not
      // been classified, tokenized, or logged, so the agent cannot have it.
      if (isAbortError(error, signal)) {
        emit(
          guardEvent("error", tool, {
            callId: gate.callId,
            detail: "cancelled during the transform call",
          }),
        );
        return CANCELLED_MESSAGE;
      }
      emit(
        guardEvent("error", tool, { callId: gate.callId, detail: `transform: ${describe(error)}` }),
      );
      return verificationFailedMessage("transform");
    }

    emit(guardEvent("transformed", tool, { callId: gate.callId, verdict: gate.verdict }));
    return toAgentString(transformed.result);
  };
}
