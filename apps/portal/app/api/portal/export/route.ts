import { intParam, param } from "@/lib/http";
import { exportPatientsCsv } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/portal/export?text=&condition=&limit=` → `text/csv`
 *
 * Bulk export of the current search result, SSNs and all. Unguarded in Phase 1;
 * docs/05 puts this behind `require-justification` once the SDK lands.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const csv = exportPatientsCsv({
    text: param(url, "text"),
    condition: param(url, "condition"),
    limit: intParam(url, "limit"),
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="lakeside-patients-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
