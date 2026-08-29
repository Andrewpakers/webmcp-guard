import type { Metadata } from "next";

import { PatientsTable } from "@/components/patients-table";
import { countPatients, searchPatients } from "@/lib/db/repository";

export const metadata: Metadata = { title: "Patients · Lakeside Medical" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The roster.
 *
 * **Not** masked at rest, unlike the chart (`patients/[id]/page.tsx`), and that
 * is a decision rather than an omission. The table's rows come from
 * `PatientSummary`, which is the same shape `/api/portal/search` returns to the
 * live search box *and* to the `search_patients` WebMCP tool — the shape whose
 * DOB the guard contextualizes and whose name and MRN it tokenizes. Masking the
 * roster would mean either shipping a different summary to the browser than to
 * the tool (two contracts to keep in step) or dropping the date-of-birth sort a
 * clinician uses to tell two same-named patients apart. The chart is where the
 * identifiers actually are — SSN, e-mail, the full record — so that is where the
 * masking earns its keep; the roster shows a DOB and a phone number, which the
 * guard already treats as contextualize-and-pass rather than secret.
 */
export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const text = first(params.text);
  const condition = first(params.condition);

  const patients = searchPatients({
    text: text || undefined,
    condition: condition || undefined,
    limit: 500,
  });
  const total = countPatients();

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Patients</h1>
        <p className="text-sm text-slate-500">
          {total} active records in the Lakeside Medical registry. Select a patient to open their
          chart.
        </p>
      </header>

      <PatientsTable initialPatients={patients} initialText={text} initialCondition={condition} />
    </div>
  );
}
