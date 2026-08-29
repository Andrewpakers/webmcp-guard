import type { Metadata } from "next";

import { ExportPanel } from "@/components/export-panel";
import { CSV_COLUMNS, countPatients } from "@/lib/db/repository";

export const metadata: Metadata = { title: "Export · Lakeside Medical" };
export const dynamic = "force-dynamic";

export default function ExportPage() {
  const total = countPatients();

  return (
    <div className="max-w-3xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Export patients</h1>
        <p className="text-sm text-slate-500">
          Download the current search result as CSV. The registry currently holds {total} patient
          records.
        </p>
      </header>

      <ExportPanel initialTotal={total} />

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-xs">
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Columns included
        </h2>
        <div className="flex flex-wrap gap-1">
          {CSV_COLUMNS.map((column) => (
            <span
              key={column}
              className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700"
            >
              {column}
            </span>
          ))}
        </div>
        <p className="mt-3 text-slate-600">
          This export contains directly identifying information for every matching patient,
          including Social Security numbers. In a real deployment that makes it the single most
          sensitive action in the application.
        </p>
      </section>
    </div>
  );
}
