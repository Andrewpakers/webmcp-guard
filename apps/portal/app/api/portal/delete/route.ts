import { jsonError, jsonOk, readJsonBody, stringField } from "@/lib/http";
import { deletePatient, patientNotFoundMessage } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/portal/delete`
 *
 * Body: `{ id }`. Hard-deletes a patient and cascades to notes and appointments.
 *
 * There is no confirmation step here on purpose: in Phase 1 the destructive tool
 * really is one call away, which is the "before" beat of the demo. Phase 2 puts
 * `require-confirmation` in front of it without touching this handler.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonError(400, "Request body must be a JSON object.");

  const id = stringField(body, "id") ?? stringField(body, "patientId");
  if (!id) return jsonError(400, "Missing required field 'id' (a patient id or MRN).");

  const deleted = deletePatient(id);
  if (!deleted) return jsonError(404, patientNotFoundMessage(id));

  return jsonOk({ deleted });
}
