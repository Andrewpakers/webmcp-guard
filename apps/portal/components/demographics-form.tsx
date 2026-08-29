"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Patient } from "@/lib/db/types";

const FIELDS = [
  { key: "firstName", label: "First name", span: 1 },
  { key: "lastName", label: "Last name", span: 1 },
  { key: "phone", label: "Phone", span: 1 },
  { key: "email", label: "E-mail", span: 1 },
  { key: "addressStreet", label: "Street", span: 2 },
  { key: "addressCity", label: "City", span: 1 },
  { key: "addressState", label: "State", span: 1 },
  { key: "addressZip", label: "ZIP", span: 1 },
  { key: "insuranceCarrier", label: "Insurance carrier", span: 1 },
  { key: "insuranceMemberId", label: "Member id", span: 1 },
] as const;

type EditableKey = (typeof FIELDS)[number]["key"];

/**
 * Editable demographics. Posts to `/api/portal/update` — the same endpoint the
 * `update_patient` tool uses — then asks Next to re-render the server component
 * so the header and the rest of the chart pick up the change.
 */
export function DemographicsForm({ patient }: { patient: Patient }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<EditableKey, string>>(
    () =>
      Object.fromEntries(FIELDS.map((field) => [field.key, patient[field.key]])) as Record<
        EditableKey,
        string
      >,
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setMessage("");

    try {
      const response = await fetch("/api/portal/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: patient.id, fields: values }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Save failed (${response.status}).`);

      setStatus("saved");
      router.refresh();
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Save failed.");
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label key={field.key} className={`text-sm ${field.span === 2 ? "sm:col-span-2" : ""}`}>
            <span className="mb-1 block font-medium text-slate-600">{field.label}</span>
            <input
              value={values[field.key]}
              onChange={(event) => {
                setStatus("idle");
                setValues((current) => ({ ...current, [field.key]: event.target.value }));
              }}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={status === "saving"}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save changes"}
        </button>
        {status === "saved" ? <span className="text-sm text-emerald-700">Saved.</span> : null}
        {status === "error" ? <span className="text-sm text-red-700">{message}</span> : null}
      </div>
    </form>
  );
}
