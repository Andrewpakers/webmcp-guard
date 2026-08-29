import { jsonError, jsonOk, readJsonBody, stringField } from "@/lib/http";
import { patientNotFoundMessage, updatePatient } from "@/lib/db/repository";
import type { PatientUpdate } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fields callers may change. Anything else in the body is ignored. */
const EDITABLE_FIELDS = [
  "firstName",
  "lastName",
  "phone",
  "email",
  "addressStreet",
  "addressCity",
  "addressState",
  "addressZip",
  "insuranceCarrier",
  "insuranceMemberId",
] as const satisfies readonly (keyof PatientUpdate)[];

/**
 * `POST /api/portal/update`
 *
 * Body: `{ id, fields: { ... } }`, or the fields flattened alongside `id`.
 * Both shapes are accepted because the edit form posts the flat version and the
 * `update_patient` tool posts the nested one.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonError(400, "Request body must be a JSON object.");

  const id = stringField(body, "id") ?? stringField(body, "patientId");
  if (!id) return jsonError(400, "Missing required field 'id' (a patient id or MRN).");

  const nested = body.fields;
  const source: Record<string, unknown> =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : body;

  const fields: PatientUpdate = {};
  for (const key of EDITABLE_FIELDS) {
    const value = source[key];
    if (typeof value === "string") fields[key] = value.trim();
  }

  if (Object.keys(fields).length === 0) {
    return jsonError(400, `No editable fields supplied. Editable: ${EDITABLE_FIELDS.join(", ")}.`);
  }

  const patient = updatePatient(id, fields);
  if (!patient) return jsonError(404, patientNotFoundMessage(id));

  return jsonOk({ patient, updated: Object.keys(fields) });
}
