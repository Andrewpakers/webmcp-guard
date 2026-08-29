import { intParam, jsonOk, param } from "@/lib/http";
import { listAppointments } from "@/lib/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/portal/appointments?withinDays=&patientId=&limit=`
 *
 * Upcoming appointments across the practice, soonest first.
 */
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const appointments = listAppointments({
    withinDays: intParam(url, "withinDays"),
    patientId: param(url, "patientId"),
    limit: intParam(url, "limit"),
  });

  return jsonOk({ appointments, total: appointments.length });
}
