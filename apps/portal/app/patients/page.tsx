import type { Metadata } from "next";

import { PatientsTable } from "@/components/patients-table";
import { countPatients, searchPatients } from "@/lib/db/repository";

export const metadata: Metadata = { title: "Patients · Lakeside Medical" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

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
