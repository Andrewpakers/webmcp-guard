"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { REVEAL_FIELD_LABELS } from "@/lib/mask";
import { revealPatientField } from "@/lib/reveal";

/**
 * Editable demographics. Posts to `/api/portal/update` — the same endpoint the
 * `update_patient` tool uses — then asks Next to re-render the server component
 * so the header and the rest of the chart pick up the change.
 *
 * ## Why phone and e-mail behave differently here
 *
 * Editing is a deliberate act, so the eight fields that are not masked at rest
 * are plain inputs with their values in them, as any form would be. Phone and
 * e-mail *are* masked at rest on this page (`lib/mask.ts`), and a pre-filled
 * `<input value="(555) 555-0100">` a few hundred pixels below a masked "Phone"
 * row would hand a scraper the value the mask above it is withholding — the
 * mask would be decoration. So those two start masked and read-only, with one
 * click to reveal them for editing, and that click is logged exactly like any
 * other reveal. A field that is never revealed is never sent on save, so it
 * cannot be blanked by accident.
 */

const FIELDS = [
  { key: "firstName", label: "First name", span: 1, masked: false },
  { key: "lastName", label: "Last name", span: 1, masked: false },
  { key: "phone", label: "Phone", span: 1, masked: true },
  { key: "email", label: "E-mail", span: 1, masked: true },
  { key: "addressStreet", label: "Street", span: 2, masked: false },
  { key: "addressCity", label: "City", span: 1, masked: false },
  { key: "addressState", label: "State", span: 1, masked: false },
  { key: "addressZip", label: "ZIP", span: 1, masked: false },
  { key: "insuranceCarrier", label: "Insurance carrier", span: 1, masked: false },
  { key: "insuranceMemberId", label: "Member id", span: 1, masked: false },
] as const;

type EditableKey = (typeof FIELDS)[number]["key"];

/** The masked-at-rest contact fields, which are also guard data classes. */
type MaskedKey = Extract<EditableKey, "phone" | "email">;

/**
 * Exactly the fields this form may put in the DOM. Not `Patient`: the page must
 * not hand a client component a record that carries `ssn`, `dob`, `phone` and
 * `email`, because everything in a client component's props is serialized into
 * the page whether it is rendered or not.
 */
export interface DemographicsFormPatient {
  id: string;
  firstName: string;
  lastName: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  insuranceCarrier: string;
  insuranceMemberId: string;
}

export function DemographicsForm({
  patient,
  masks,
}: {
  patient: DemographicsFormPatient;
  /** Server-computed masks for the two fields whose values stay behind. */
  masks: Record<MaskedKey, string>;
}) {
  const router = useRouter();
  // Masked keys are absent until revealed; absent keys are not sent on save.
  const [values, setValues] = useState<Partial<Record<EditableKey, string>>>(() => ({
    firstName: patient.firstName,
    lastName: patient.lastName,
    addressStreet: patient.addressStreet,
    addressCity: patient.addressCity,
    addressState: patient.addressState,
    addressZip: patient.addressZip,
    insuranceCarrier: patient.insuranceCarrier,
    insuranceMemberId: patient.insuranceMemberId,
  }));
  const [revealing, setRevealing] = useState<MaskedKey | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  async function reveal(key: MaskedKey) {
    setRevealing(key);
    setMessage("");
    try {
      const value = await revealPatientField(patient.id, key);
      setValues((current) => ({ ...current, [key]: value }));
      setStatus("idle");
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "Could not reveal this field.");
    } finally {
      setRevealing(null);
    }
  }

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
        {FIELDS.map((field) => {
          const value = values[field.key];
          // `masked` is a literal on every entry, so this narrows `key` too.
          const maskedKey = field.masked ? field.key : null;
          const hidden = maskedKey !== null && value === undefined;
          const inputId = `demographics-${field.key}`;

          return (
            <div key={field.key} className={`text-sm ${field.span === 2 ? "sm:col-span-2" : ""}`}>
              <label htmlFor={inputId} className="mb-1 block font-medium text-slate-600">
                {field.label}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={inputId}
                  data-testid={inputId}
                  value={hidden && maskedKey !== null ? masks[maskedKey] : (value ?? "")}
                  readOnly={hidden}
                  aria-readonly={hidden}
                  onChange={(event) => {
                    if (hidden) return;
                    setStatus("idle");
                    setValues((current) => ({ ...current, [field.key]: event.target.value }));
                  }}
                  className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${
                    hidden ? "bg-slate-50 tracking-wider text-slate-500 select-none" : "bg-white"
                  }`}
                />
                {hidden && maskedKey !== null ? (
                  <button
                    type="button"
                    data-testid={`demographics-reveal-${maskedKey}`}
                    onClick={() => void reveal(maskedKey)}
                    disabled={revealing !== null}
                    title={`Reveal the ${REVEAL_FIELD_LABELS[maskedKey]} to edit it — this access is recorded in the WebMCP Guard audit log`}
                    className="shrink-0 rounded-md border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-50"
                  >
                    {revealing === maskedKey ? "Revealing…" : "Reveal to edit"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
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
