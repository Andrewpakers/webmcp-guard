import { WIRE_VERSION } from "@webmcp-guard/shared";

/**
 * The console's HTTP client for the portal-mounted WebMCP Guard admin API
 * (`docs/03-architecture.md`: the console is a stateless client — it has no
 * database and no server session of its own).
 *
 * Everything here is pure plumbing so it can be unit-tested against a stubbed
 * `fetch`:
 *
 *  - requests carry `Authorization: Bearer <admin token>` and, when they have a
 *    body, the versioned envelope `{ version: 1, payload }`;
 *  - responses are unwrapped from `{ version, payload }`, and
 *    `{ version, error: { code, message } }` becomes a {@link GuardApiError};
 *  - a 401 fires `onUnauthorized` before throwing, which is what drops the
 *    stored token and bounces the operator back to `/login`.
 */

/** Server-side codes from `packages/server/src/http.ts`, plus client-only ones. */
export const GUARD_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "conflict",
  "internal_error",
  /** The request never reached the endpoint (DNS, CORS, offline, abort). */
  "network",
  /** A 2xx that was not a WebMCP Guard envelope — usually the wrong base URL. */
  "invalid_response",
  /** No admin token is held, so the request was never attempted. */
  "no_token",
] as const;

export type GuardErrorCode = (typeof GUARD_ERROR_CODES)[number];

function isGuardErrorCode(value: unknown): value is GuardErrorCode {
  return (
    typeof value === "string" && (GUARD_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Every failure the console can render, with a message safe to show as-is. */
export class GuardApiError extends Error {
  readonly code: GuardErrorCode;
  /** HTTP status, or `0` when the request never got a response. */
  readonly status: number;

  constructor(code: GuardErrorCode, message: string, status = 0) {
    super(message);
    this.name = "GuardApiError";
    this.code = code;
    this.status = status;
  }

  get isUnauthorized(): boolean {
    return this.code === "unauthorized" || this.status === 401;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GuardTransportConfig {
  /** Base URL of the mounted API, e.g. `http://localhost:3000/api/guard`. */
  baseUrl: string;
  /** Admin bearer token, or `null` when the console is not connected. */
  token: string | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Called once per 401, before the error is thrown. */
  onUnauthorized?: (error: GuardApiError) => void;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface GuardRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below the mount, with a leading slash: `/logs`, `/policies/foo`. */
  path: string;
  query?: Record<string, QueryValue>;
  /** Wrapped in the `{ version, payload }` envelope. Omit for GET/DELETE. */
  body?: unknown;
  signal?: AbortSignal;
}

/** `http://host/api/guard` + `/logs` → `http://host/api/guard/logs`. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Query string builder. Blank and nullish values are dropped, so an untouched
 * filter box never turns into `?tool=` (which the server would ignore anyway).
 */
export function buildQueryString(query: Record<string, QueryValue> | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text.length === 0) continue;
    params.set(key, text);
  }
  const encoded = params.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}

const STATUS_CODES: Record<number, GuardErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
};

function statusCode(status: number): GuardErrorCode {
  return STATUS_CODES[status] ?? "internal_error";
}

function readErrorBody(body: unknown, status: number): GuardApiError | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const raw = (body as { error: unknown }).error;
  if (typeof raw !== "object" || raw === null) return null;
  const { code, message } = raw as { code?: unknown; message?: unknown };
  return new GuardApiError(
    isGuardErrorCode(code) ? code : statusCode(status),
    typeof message === "string" && message.length > 0
      ? message
      : `The guard API returned HTTP ${status}.`,
    status,
  );
}

/**
 * One request/response round trip. Resolves with the unwrapped payload, or
 * throws a {@link GuardApiError} — never a raw `TypeError` from `fetch`.
 */
export async function guardRequest<T>(
  config: GuardTransportConfig,
  options: GuardRequestOptions,
): Promise<T> {
  const { baseUrl, token, fetchImpl, onUnauthorized } = config;

  const fail = (error: GuardApiError): never => {
    if (error.isUnauthorized) onUnauthorized?.(error);
    throw error;
  };

  if (token === null || token.length === 0) {
    return fail(
      new GuardApiError("no_token", "Not connected. Enter the admin token to continue."),
    );
  }

  const method = options.method ?? "GET";
  const url = joinUrl(baseUrl, options.path) + buildQueryString(options.query);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({ version: WIRE_VERSION, payload: options.body });
  }
  if (options.signal !== undefined) init.signal = options.signal;

  const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (doFetch === undefined) {
    return fail(new GuardApiError("network", "This environment has no fetch implementation."));
  }

  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      new GuardApiError(
        "network",
        `Could not reach the guard API at ${baseUrl} — ${detail}. Check the endpoint URL, that the portal is running, and that it allows this console's origin.`,
      ),
    );
  }

  let body: unknown;
  let parsedBody = true;
  try {
    body = await response.json();
  } catch {
    parsedBody = false;
  }

  if (parsedBody) {
    const failure = readErrorBody(body, response.status);
    if (failure !== null) return fail(failure);
  }

  if (!response.ok) {
    return fail(
      new GuardApiError(
        statusCode(response.status),
        `The guard API returned HTTP ${response.status} for ${method} ${options.path}.`,
        response.status,
      ),
    );
  }

  if (!parsedBody || typeof body !== "object" || body === null || !("payload" in body)) {
    return fail(
      new GuardApiError(
        "invalid_response",
        `${baseUrl} answered without a WebMCP Guard envelope. Is NEXT_PUBLIC_GUARD_API_URL pointing at the portal's /api/guard mount?`,
        response.status,
      ),
    );
  }

  const { version, payload } = body as { version?: unknown; payload: unknown };
  if (version !== WIRE_VERSION) {
    return fail(
      new GuardApiError(
        "invalid_response",
        `The guard API speaks wire version ${String(version)}; this console speaks ${WIRE_VERSION}.`,
        response.status,
      ),
    );
  }

  return payload as T;
}

/** Turns any thrown value into a sentence the UI can render. */
export function errorMessage(error: unknown): string {
  if (error instanceof GuardApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
