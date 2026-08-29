import { WIRE_VERSION, wireEnvelope } from "@webmcp-guard/shared";
import type { z } from "zod";

/**
 * HTTP plumbing shared by every WebMCP Guard route.
 *
 * Successful responses travel in the versioned envelope from
 * `@webmcp-guard/shared` (`{ version: 1, payload }`). Failures use the same
 * envelope with an `error` member instead of a payload:
 *
 * ```json
 * { "version": 1, "error": { "code": "bad_request", "message": "…" } }
 * ```
 *
 * The message is always safe to show to whoever asked — including an agent, so
 * it is written in plain language and never contains internals.
 */

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "method_not_allowed",
  "conflict",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface GuardErrorBody {
  version: typeof WIRE_VERSION;
  error: { code: ErrorCode; message: string };
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** A `{ version, payload }` success response. */
export function jsonPayload(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ version: WIRE_VERSION, payload }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** A `{ version, error }` failure response. */
export function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body: GuardErrorBody = { version: WIRE_VERSION, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

const MAX_ISSUE_TEXT = 400;

/** Turns a zod failure into one line an agent (or a developer) can act on. */
export function describeZodError(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return issues.length > MAX_ISSUE_TEXT ? `${issues.slice(0, MAX_ISSUE_TEXT)}…` : issues;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Reads a request body, checks it against `{ version, payload }` with the given
 * payload schema, and hands back either the payload or a ready-made 400.
 */
export async function parseEnvelope<S extends z.ZodTypeAny>(
  request: Request,
  payloadSchema: S,
  headers: Record<string, string> = {},
): Promise<ParseResult<z.infer<S>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError(
        400,
        "bad_request",
        `Request body must be JSON in the WebMCP Guard envelope: {"version":${WIRE_VERSION},"payload":{…}}.`,
        headers,
      ),
    };
  }

  const parsed = wireEnvelope(payloadSchema).safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        400,
        "bad_request",
        `Request does not match the WebMCP Guard wire contract (version ${WIRE_VERSION}) — ${describeZodError(parsed.error)}`,
        headers,
      ),
    };
  }

  return { ok: true, value: parsed.data.payload as z.infer<S> };
}

/** Checks a plain (non-enveloped) object against a schema, e.g. query params. */
export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
  headers: Record<string, string> = {},
): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        400,
        "bad_request",
        `Invalid ${what} — ${describeZodError(parsed.error)}`,
        headers,
      ),
    };
  }
  return { ok: true, value: parsed.data as z.infer<S> };
}

/** Query string → plain object, dropping blanks so `?tool=` means "no filter". */
export function queryObject(url: URL): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const trimmed = value.trim();
    if (trimmed.length > 0) entries[key] = trimmed;
  }
  return entries;
}

/** Caps a caller-controlled string before it is stored or echoed back. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
