import { jsonError, jsonOk, param } from "@/lib/http";
import { getPatient, patientNotFoundMessage } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/portal/get?id=<patient id or MRN>`
 *
 * Full record including notes and appointments. Phase 1 returns it raw.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const id = param(url, "id");
  if (!id) return jsonError(400, "Missing required query parameter 'id' (a patient id or MRN).");

  const patient = getPatient(id);
  if (!patient) return jsonError(404, patientNotFoundMessage(id));

  return jsonOk({ patient });
}
