"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const AUTHORS = [
  "Dr. Alicia Reyes",
  "Dr. Marcus Tan",
  "Dr. Priya Raman",
  "NP Dana Okafor",
  "Dr. Elliot Frank",
];

/** Appends a visit note via `/api/portal/add-note`, then refreshes the timeline. */
export function AddNoteForm({ patientId }: { patientId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [author, setAuthor] = useState(AUTHORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;

    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/portal/add-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId, body, author }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error ?? `Could not add note (${response.status}).`);

      setBody("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-600">New visit note</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="Called about refill; approved a 30-day supply and scheduled a BP recheck."
          className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="sr-only">Author</span>
          <select
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500"
          >
            {AUTHORS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={saving || !body.trim()}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add note"}
        </button>
        {error ? <span className="text-sm text-red-700">{error}</span> : null}
      </div>
    </form>
  );
}
