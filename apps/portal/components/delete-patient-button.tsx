"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Deletes a patient after a native confirm dialog.
 *
 * The human path asks first; the `delete_patient` WebMCP tool, in Phase 1, does
 * not — that asymmetry is the point docs/05 wants the video to land. Phase 2
 * puts `require-confirmation` in front of the agent path too.
 */
export function DeletePatientButton({
  patientId,
  name,
  mrn,
}: {
  patientId: string;
  name: string;
  mrn: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    const confirmed = window.confirm(
      `Permanently delete ${name} (${mrn})?\n\nThis removes their chart, every visit note and every appointment. It cannot be undone.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/portal/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: patientId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Delete failed (${response.status}).`);

      router.replace("/patients");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void remove()}
        disabled={busy}
        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete patient"}
      </button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}
