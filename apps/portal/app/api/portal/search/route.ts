import { intParam, jsonOk, param } from "@/lib/http";
import { countPatients, searchPatients } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/portal/search?text=&condition=&limit=`
 *
 * Patient lookup for the list view and for the `search_patients` WebMCP tool.
 * Returns summaries only (no SSN, no insurance) — but names, MRNs, DOBs and
 * phone numbers are all in the clear, which is the point of the Phase 1
 * baseline.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const query = {
    text: param(url, "text"),
    condition: param(url, "condition"),
    limit: intParam(url, "limit"),
  };

  return jsonOk({
    patients: searchPatients(query),
    total: countPatients(query),
  });
}
