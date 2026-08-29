import { getPatient, patientNotFoundMessage } from "@/lib/db/repository";
import type { PatientDetail } from "@/lib/db/types";
import { logFieldReveal } from "@/lib/guard/audit";
import { jsonError, jsonOk, readJsonBody, stringField } from "@/lib/http";
import { REVEALABLE_FIELDS, isRevealableField, type RevealableField } from "@/lib/mask";
import { readPortalSession } from "@/lib/session/cookie";
import { sessionContextOf } from "@/lib/session/personas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/portal/reveal-field`
 *
 * Body: `{ patientId, field }` with `field` one of {@link REVEALABLE_FIELDS}.
 * Returns `{ value }` — and writes a human access event into the guard's audit
 * log *first* (`docs/05` § stretch; `docs/03` threat model, mitigation (1)).
 *
 * This is the only way the browser can obtain an SSN, DOB, phone number or
 * e-mail address for a patient: the chart page renders masks and never ships
 * these values (`lib/mask.ts`). An agent that scrapes the DOM instead of calling
 * the guarded WebMCP tools therefore gets bullets, and an agent that finds this
 * route and calls it gets the value **and an audit entry naming the session it
 * used**, which is exactly the trade the mitigation claims.
 *
 * ## What protects it
 *
 * The portal's own session, the same boundary as every other `/api/portal/*`
 * route and the same one that protects the pages themselves — this hands a
 * signed-in clinician data they can already read on their own screen. The
 * session is resolved **server-side from the signed cookie**, exactly as the
 * guard's `resolveSession` does it, so the identity written into the log is
 * never one the caller asserted.
 *
 * Order of operations is the security-relevant part: resolve → look up → **log**
 * → answer. A failure to record the reveal fails the reveal.
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload) return jsonError(400, "Request body must be a JSON object.");

  const patientId = stringField(payload, "patientId") ?? stringField(payload, "id");
  if (!patientId) {
    return jsonError(400, "Missing required field 'patientId' (a patient id or MRN).");
  }

  const field = stringField(payload, "field");
  if (!isRevealableField(field)) {
    return jsonError(
      400,
      `Missing or unknown field '${field ?? ""}'. Revealable fields are: ${REVEALABLE_FIELDS.join(", ")}.`,
    );
  }

  const patient = getPatient(patientId);
  if (!patient) return jsonError(404, patientNotFoundMessage(patientId));

  // Never from the request body, never from a header the page controls.
  const { persona } = readPortalSession(request);

  await logFieldReveal({
    mrn: patient.mrn,
    field,
    session: sessionContextOf(persona),
    actorName: persona.name,
    userAgent: request.headers.get("user-agent"),
  });

  return jsonOk({
    patientId: patient.id,
    mrn: patient.mrn,
    field,
    value: valueOf(patient, field),
    revealedBy: persona.name,
  });
}

/** The four masked fields, mapped onto the columns they live in. */
function valueOf(patient: PatientDetail, field: RevealableField): string {
  switch (field) {
    case "ssn":
      return patient.ssn;
    case "dob":
      return patient.dob;
    case "phone":
      return patient.phone;
    case "email":
      return patient.email;
  }
}
