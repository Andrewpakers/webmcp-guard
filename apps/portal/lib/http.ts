/**
 * Tiny helpers shared by the `app/api/portal/*` route handlers so every response
 * has the same shape: `{ ok: true, ... }` or `{ ok: false, error }`.
 *
 * The WebMCP tools in `lib/webmcp/` are the main consumer, and an agent reads
 * whatever comes back — so error strings are written to be legible to a model,
 * not just to a developer.
 */

export function jsonOk(payload: Record<string, unknown>, status = 200): Response {
  return Response.json({ ok: true, ...payload }, { status });
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/** Reads a JSON body, returning `null` instead of throwing on malformed input. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A trimmed non-empty query-string value, or `undefined`. */
export function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

/** A positive integer query-string value, or `undefined`. */
export function intParam(url: URL, name: string): number | undefined {
  const raw = param(url, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Narrows an unknown JSON value to a trimmed non-empty string. */
export function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
