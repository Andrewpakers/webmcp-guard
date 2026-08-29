import { jsonError, jsonOk, readJsonBody, stringField } from "@/lib/http";
import { addVisitNote } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTE_LENGTH = 4000;

/**
 * `POST /api/portal/add-note`
 *
 * Body: `{ patientId, body, author? }`. Appends a free-text clinical note; the
 * detail page's timeline picks it up immediately.
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload) return jsonError(400, "Request body must be a JSON object.");

  const patientId = stringField(payload, "patientId") ?? stringField(payload, "id");
  if (!patientId)
    return jsonError(400, "Missing required field 'patientId' (a patient id or MRN).");

  const noteBody = stringField(payload, "body") ?? stringField(payload, "note");
  if (!noteBody) return jsonError(400, "Missing required field 'body' (the note text).");
  if (noteBody.length > MAX_NOTE_LENGTH) {
    return jsonError(400, `Note text must be ${MAX_NOTE_LENGTH} characters or fewer.`);
  }

  const author = stringField(payload, "author") ?? "Portal user";
  const note = addVisitNote(patientId, noteBody, author);
  if (!note) return jsonError(404, `No patient found for '${patientId}'.`);

  return jsonOk({ note }, 201);
}
