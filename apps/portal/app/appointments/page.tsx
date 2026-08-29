import type { Metadata } from "next";
import Link from "next/link";

import { listAppointments } from "@/lib/db/repository";
import { daysUntil, describeLeadTime, formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Appointments · Lakeside Medical" };
export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-700",
  confirmed: "bg-emerald-50 text-emerald-800",
  "checked-in": "bg-blue-50 text-blue-800",
};

export default function AppointmentsPage() {
  const appointments = listAppointments({ withinDays: 60 });
  const thisWeek = appointments.filter((a) => daysUntil(a.scheduledAt) <= 7).length;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Appointments</h1>
        <p className="text-sm text-slate-500">
          {appointments.length} upcoming in the next 60 days · {thisWeek} within the next 7 days.
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
        <table className="w-full min-w-[48rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
              <th scope="col" className="px-3 py-2 font-medium">
                When
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Patient
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Reason
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Provider
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr
                key={appointment.id}
                className="border-b border-slate-100 last:border-0 hover:bg-blue-50/40"
              >
                <td className="px-3 py-2 whitespace-nowrap text-slate-800">
                  {formatDateTime(appointment.scheduledAt)}
                  <div className="text-xs text-slate-500">
                    {describeLeadTime(appointment.scheduledAt)}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/patients/${appointment.patientMrn}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {appointment.patientName}
                  </Link>
                  <div className="font-mono text-xs text-slate-500">{appointment.patientMrn}</div>
                </td>
                <td className="px-3 py-2 text-slate-700">{appointment.reason}</td>
                <td className="px-3 py-2 text-slate-700">{appointment.provider}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[appointment.status] ?? STATUS_STYLES.scheduled
                    }`}
                  >
                    {appointment.status}
                  </span>
                </td>
              </tr>
            ))}
            {appointments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                  Nothing on the schedule.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
