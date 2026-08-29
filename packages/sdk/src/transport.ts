import {
  type EffectivePolicy,
  EffectivePolicyEnvelopeSchema,
  type GateRequest,
  type GateResponse,
  GateResponseEnvelopeSchema,
  type TransformRequest,
  type TransformResponse,
  TransformResponseEnvelopeSchema,
  WIRE_VERSION,
} from "@webmcp-guard/shared";

import { isAbortError } from "./abort";
import type { GuardStage } from "./messages";

/**
 * The two HTTP round trips of the pipeline, and the only place the SDK trusts
 * anything the network says.
 *
 * Every response is validated against the versioned envelope from
 * `@webmcp-guard/shared` before a single field is read. A response that is not
 * 2xx, not JSON, not the expected wire version, or not schema-shaped is treated
 * exactly like a network outage: it throws, and the caller fails closed.
 */

/** A failed round trip. `reason` is page-local detail — never shown to the agent. */
export class GuardStageError extends Error {
  readonly stage: GuardStage;
  readonly reason: string;

  constructor(stage: GuardStage, reason: string) {
    super(`WebMCP Guard ${stage} failed: ${reason}`);
    this.name = "GuardStageError";
    this.stage = stage;
    this.reason = reason;
  }
}

export interface TransportConfig {
  /** Normalized base URL of the mounted guard server, e.g. `"/api/guard"`. */
  endpoint: string;
  fetchImpl: typeof fetch;
}

/** Trims trailing slashes so `${endpoint}/gate` is always well formed. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * POSTs `{ version: 1, payload }` and returns the parsed JSON body, or throws a
 * {@link GuardStageError}. Aborts are rethrown untouched so the pipeline can
 * tell "cancelled" from "broken".
 */
async function postEnvelope(
  stage: GuardStage,
  config: TransportConfig,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let body: string;
  try {
    body = JSON.stringify({ version: WIRE_VERSION, payload });
  } catch (error) {
    // Circular structures and BigInts cannot cross the wire. Refusing here is
    // the same fail-closed outcome as a server that never answered.
    throw new GuardStageError(stage, `request could not be serialized (${describe(error)})`);
  }

  let response: Response;
  try {
    response = await config.fetchImpl(`${config.endpoint}/${stage}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      // The guard server authenticates with the host app's own session cookie.
      // Never `"include"`: these requests are same-origin by construction.
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new GuardStageError(stage, `request failed (${describe(error)})`);
  }

  if (!response.ok) {
    throw new GuardStageError(stage, `server responded ${response.status}`);
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new GuardStageError(stage, `response was not JSON (${describe(error)})`);
  }
}

/** `POST ${endpoint}/gate` — policy verdict + detokenized args. */
export async function postGate(
  config: TransportConfig,
  request: GateRequest,
  signal?: AbortSignal,
): Promise<GateResponse> {
  const json = await postEnvelope("gate", config, request, signal);
  const parsed = GateResponseEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new GuardStageError("gate", "response did not match the guard wire contract");
  }
  return parsed.data.payload;
}

/**
 * `GET ${endpoint}/policies/effective` — what policy says about a tool, before
 * it is registered (`docs/04` behavior 3).
 *
 * Returns `null` for **every** failure — offline, 404 from an older guard
 * server, a body that does not match the wire contract. That is the
 * availability-over-enforcement call this endpoint is allowed to make: it only
 * shapes an input schema, and the gate re-decides the same policy server-side
 * on every call regardless. A page that cannot reach the guard should still
 * register its tools; the first call will fail closed and say so.
 *
 * Aborts are the one thing rethrown, so a caller can tell "the caller went
 * away" from "the guard did not answer".
 */
export async function getEffectivePolicy(
  config: TransportConfig,
  query: { app: string; tool: string; tags?: readonly string[] },
  signal?: AbortSignal,
): Promise<EffectivePolicy | null> {
  const params = new URLSearchParams({ app: query.app, tool: query.tool });
  if (query.tags && query.tags.length > 0) params.set("tags", query.tags.join(","));

  try {
    const response = await config.fetchImpl(
      `${config.endpoint}/policies/effective?${params.toString()}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal,
      },
    );
    if (!response.ok) return null;

    const parsed = EffectivePolicyEnvelopeSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.payload : null;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return null;
  }
}

/** `POST ${endpoint}/transform` — classify, transform, and log the result. */
export async function postTransform(
  config: TransportConfig,
  request: TransformRequest,
  signal?: AbortSignal,
): Promise<TransformResponse> {
  const json = await postEnvelope("transform", config, request, signal);
  const parsed = TransformResponseEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new GuardStageError("transform", "response did not match the guard wire contract");
  }
  return parsed.data.payload;
}
