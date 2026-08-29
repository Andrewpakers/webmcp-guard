import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AddNoteForm } from "@/components/add-note-form";
import { DeletePatientButton } from "@/components/delete-patient-button";
import { DemographicsForm } from "@/components/demographics-form";
import { getPatient } from "@/lib/db/repository";
import { ageFromDob, describeLeadTime, formatDate, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const patient = getPatient(decodeURIComponent(id));
  return {
    title: patient
      ? `${patient.lastName}, ${patient.firstName} · Lakeside Medical`
      : "Patient not found · Lakeside Medical",
  };
}

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patient = getPatient(decodeURIComponent(id));
  if (!patient) notFound();

  const age = ageFromDob(patient.dob);
  const upcoming = patient.appointments.filter((a) => new Date(a.scheduledAt) >= new Date());

  return (
    <div className="space-y-5">
      <nav className="text-sm text-slate-500">
        <Link href="/patients" className="hover:text-slate-800 hover:underline">
          Patients
        </Link>
        <span className="px-1.5">/</span>
        <span className="text-slate-700">{patient.mrn}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {patient.lastName}, {patient.firstName}
          </h1>
          <p className="text-sm text-slate-600">
            <span className="font-mono text-xs">{patient.mrn}</span>
            <span className="px-1.5 text-slate-300">|</span>
            DOB {formatDate(patient.dob)}
            {age === null ? "" : ` (${age}y)`}
            <span className="px-1.5 text-slate-300">|</span>
            SSN {patient.ssn}
          </p>
          <div className="flex flex-wrap gap-1 pt-1">
            {patient.primaryConditions.map((condition) => (
              <span
                key={condition}
                className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800"
              >
                {condition}
              </span>
            ))}
          </div>
        </div>
        <DeletePatientButton
          patientId={patient.id}
          name={`${patient.firstName} ${patient.lastName}`}
          mrn={patient.mrn}
        />
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Demographics & contact">
            <DemographicsForm patient={patient} />
          </Card>

          <Card title={`Visit notes (${patient.notes.length})`}>
            <div className="space-y-3">
              <AddNoteForm patientId={patient.id} />
              <ol className="space-y-3">
                {patient.notes.map((note) => (
                  <li
                    key={note.id}
                    className="rounded-lg border border-slate-200 bg-white p-3 text-sm"
                  >
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-700">{note.author}</span>
                      <time className="text-slate-500" dateTime={note.authoredAt}>
                        {formatDateTime(note.authoredAt)}
                      </time>
                    </div>
                    <p className="leading-relaxed text-slate-700">{note.body}</p>
                  </li>
                ))}
                {patient.notes.length === 0 ? (
                  <li className="text-sm text-slate-500">No notes on file.</li>
                ) : null}
              </ol>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Insurance">
            <dl className="space-y-2 text-sm">
              <Row label="Carrier" value={patient.insuranceCarrier} />
              <Row label="Member id" value={patient.insuranceMemberId} mono />
              <Row
                label="Address"
                value={`${patient.addressStreet}, ${patient.addressCity}, ${patient.addressState} ${patient.addressZip}`}
              />
              <Row label="Phone" value={patient.phone} />
              <Row label="E-mail" value={patient.email} />
            </dl>
          </Card>

          <Card title="Medications">
            <ul className="space-y-1 text-sm text-slate-700">
              {patient.medications.map((medication) => (
                <li key={medication}>{medication}</li>
              ))}
              {patient.medications.length === 0 ? (
                <li className="text-slate-500">None recorded.</li>
              ) : null}
            </ul>
          </Card>

          <Card title="Allergies">
            <div className="flex flex-wrap gap-1">
              {patient.allergies.map((allergy) => (
                <span
                  key={allergy}
                  className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800"
                >
                  {allergy}
                </span>
              ))}
              {patient.allergies.length === 0 ? (
                <span className="text-sm text-slate-500">No known allergies.</span>
              ) : null}
            </div>
          </Card>

          <Card title="Upcoming appointments">
            <ul className="space-y-2 text-sm">
              {upcoming.map((appointment) => (
                <li key={appointment.id} className="border-b border-slate-100 pb-2 last:border-0">
                  <div className="font-medium text-slate-800">
                    {formatDateTime(appointment.scheduledAt)}
                    <span className="pl-1.5 text-xs font-normal text-slate-500">
                      · {describeLeadTime(appointment.scheduledAt)}
                    </span>
                  </div>
                  <div className="text-slate-600">{appointment.reason}</div>
                  <div className="text-xs text-slate-500">
                    {appointment.provider} · {appointment.status}
                  </div>
                </li>
              ))}
              {upcoming.length === 0 ? (
                <li className="text-slate-500">Nothing scheduled.</li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-800 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
