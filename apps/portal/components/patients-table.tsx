"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ageFromDob, describeLeadTime, formatDate } from "@/lib/format";
import type { PatientSummary } from "@/lib/db/types";
import { PORTAL_DATA_CHANGED_EVENT } from "@/lib/webmcp/status";

type SortKey = "name" | "mrn" | "dob" | "conditions" | "next";
type SortDirection = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Patient" },
  { key: "mrn", label: "MRN" },
  { key: "dob", label: "Date of birth" },
  { key: "conditions", label: "Primary conditions" },
  { key: "next", label: "Next appointment" },
];

function sortValue(patient: PatientSummary, key: SortKey): string {
  switch (key) {
    case "name":
      return `${patient.lastName} ${patient.firstName}`.toLowerCase();
    case "mrn":
      return patient.mrn;
    case "dob":
      return patient.dob;
    case "conditions":
      return patient.primaryConditions.join(", ").toLowerCase();
    case "next":
      // Patients with nothing booked sort last in ascending order.
      return patient.nextAppointmentAt ?? "9999";
  }
}

/**
 * The patient roster.
 *
 * Server-rendered on first paint (so a shared `/patients?condition=...` link
 * works and the page is useful with JS still loading), then the search box takes
 * over and talks to `/api/portal/search` — the same endpoint the
 * `search_patients` WebMCP tool calls.
 */
export function PatientsTable({
  initialPatients,
  initialText,
  initialCondition,
}: {
  initialPatients: PatientSummary[];
  initialText: string;
  initialCondition: string;
}) {
  const [text, setText] = useState(initialText);
  const [condition, setCondition] = useState(initialCondition);
  const [patients, setPatients] = useState(initialPatients);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "name",
    direction: "asc",
  });

  // A server refresh (an agent just changed something) wins over stale state.
  useEffect(() => setPatients(initialPatients), [initialPatients]);

  const requestId = useRef(0);

  const runSearch = useCallback(async (nextText: string, nextCondition: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (nextText.trim()) params.set("text", nextText.trim());
      if (nextCondition.trim()) params.set("condition", nextCondition.trim());

      const response = await fetch(`/api/portal/search?${params.toString()}`);
      const payload = (await response.json()) as { patients?: PatientSummary[]; error?: string };
      if (id !== requestId.current) return;

      if (!response.ok) throw new Error(payload.error ?? `Search failed (${response.status}).`);
      setPatients(payload.patients ?? []);
    } catch (cause) {
      if (id === requestId.current)
        setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  // Debounced live search; skipped on first render because the server already
  // rendered exactly this query.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => void runSearch(text, condition), 250);
    return () => clearTimeout(timer);
  }, [text, condition, runSearch]);

  // An agent tool mutated data: re-run the current query.
  useEffect(() => {
    const handler = () => void runSearch(text, condition);
    window.addEventListener(PORTAL_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PORTAL_DATA_CHANGED_EVENT, handler);
  }, [text, condition, runSearch]);

  const sorted = useMemo(() => {
    const rows = [...patients];
    rows.sort((a, b) => {
      const result = sortValue(a, sort.key).localeCompare(sortValue(b, sort.key));
      return sort.direction === "asc" ? result : -result;
    });
    return rows;
  }, [patients, sort]);

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 basis-64 text-sm">
          <span className="mb-1 block font-medium text-slate-700">Search</span>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Name, MRN, e-mail or phone"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="flex-1 basis-56 text-sm">
          <span className="mb-1 block font-medium text-slate-700">Condition</span>
          <input
            type="search"
            value={condition}
            onChange={(event) => setCondition(event.target.value)}
            placeholder="e.g. hypertension"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <p className="pb-2 text-sm text-slate-500" aria-live="polite">
          {loading ? "Searching…" : `${sorted.length} patient${sorted.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-xs">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className="px-3 py-2 font-medium text-slate-600">
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className="inline-flex items-center gap-1 hover:text-slate-900"
                  >
                    {column.label}
                    <span aria-hidden className="text-[10px] text-slate-400">
                      {sort.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((patient) => {
              const age = ageFromDob(patient.dob);
              return (
                <tr
                  key={patient.id}
                  className="border-b border-slate-100 last:border-0 hover:bg-blue-50/40"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/patients/${patient.mrn}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {patient.lastName}, {patient.firstName}
                    </Link>
                    <div className="text-xs text-slate-500">{patient.phone}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{patient.mrn}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {formatDate(patient.dob)}
                    {age === null ? "" : <span className="text-slate-400"> · {age}y</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {patient.primaryConditions.map((condition) => (
                        <span
                          key={condition}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                        >
                          {condition}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {patient.nextAppointmentAt ? (
                      <>
                        {formatDate(patient.nextAppointmentAt)}
                        <span className="text-slate-400">
                          {" "}
                          · {describeLeadTime(patient.nextAppointmentAt)}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400">None scheduled</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && !loading ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-slate-500">
                  No patients match this search.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
