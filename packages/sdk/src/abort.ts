/**
 * Cancellation is the one failure mode that is *not* an error: the agent (or
 * the browser) went away, so the right answer is a short "cancelled" note, not
 * a fail-closed warning about withheld results.
 */

/**
 * Best-effort detection of an abort, across the several shapes it arrives in:
 * `fetch` rejects with a `DOMException` named `AbortError`, Node's undici uses
 * the same name, and site code may throw its own object with that name.
 * An already-aborted signal is treated as authoritative on its own.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
