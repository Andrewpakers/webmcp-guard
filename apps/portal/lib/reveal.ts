import type { RevealableField } from "./mask";

/**
 * Browser half of the masked-at-rest reveal (`lib/mask.ts` explains the rule).
 *
 * Client-safe: `fetch` and nothing else. The value it returns is held in React
 * state for as long as the field is un-masked and is dropped on re-mask, so the
 * next reveal is a fresh request — and therefore a fresh audit entry. Caching it
 * would make the second look at an SSN invisible to the log.
 */

export const REVEAL_FIELD_ENDPOINT = "/api/portal/reveal-field";

interface RevealResponseBody {
  value?: unknown;
  error?: unknown;
}

/**
 * Asks the portal for one masked field of one patient.
 *
 * Rejects with a message written for a person reading it inside a chart, since
 * that is where it is rendered.
 */
export async function revealPatientField(
  patientId: string,
  field: RevealableField,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(REVEAL_FIELD_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patientId, field }),
    ...(signal === undefined ? {} : { signal }),
  });

  let payload: RevealResponseBody = {};
  try {
    payload = (await response.json()) as RevealResponseBody;
  } catch {
    // A non-JSON body (a proxy error page, say) leaves the status to explain.
  }

  if (!response.ok || typeof payload.value !== "string") {
    const message = typeof payload.error === "string" ? payload.error : null;
    throw new Error(message ?? `Could not reveal this field (${response.status}).`);
  }
  return payload.value;
}
