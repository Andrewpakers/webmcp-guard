"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PERSONAS, personaOrDefault } from "@/lib/session/personas";

/**
 * The header's "Signed in as …" control — the portal's mock login (`docs/05`).
 *
 * Picking a name POSTs to `/api/session`, which signs a session cookie for that
 * persona, and then refreshes the page so every server component (and the
 * `<body>` bootstrap the SDK reads) sees the new identity. The next tool call an
 * agent makes carries the new role, and the guard's seeded
 * `role-billing-notes-masked` rule starts (or stops) applying — with no reload
 * of the agent's session and no redeploy.
 *
 * A plain `<select>` on purpose: it is one obvious click in a demo video, it is
 * keyboard and screen-reader accessible for free, and it is trivially drivable
 * from the headless e2e harness.
 */
export function PersonaSwitcher({ activeId }: { activeId: string }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const active = personaOrDefault(pendingId ?? activeId);

  async function choose(id: string): Promise<void> {
    if (id === activeId) return;
    setPendingId(id);
    setFailed(false);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: id }),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Server components re-render with the new persona; the display cookie is
      // already set, so a tool call in flight would pick it up either way.
      router.refresh();
    } catch {
      setFailed(true);
      setPendingId(null);
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <label htmlFor="persona-switcher" className="whitespace-nowrap">
        Signed in as
      </label>
      <select
        id="persona-switcher"
        data-testid="persona-switcher"
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-300"
        value={active.id}
        title="Mock login — three demo staff identities. Switching changes the role WebMCP Guard enforces policy against."
        onChange={(event) => void choose(event.target.value)}
      >
        {PERSONAS.map((persona) => (
          <option key={persona.id} value={persona.id}>
            {persona.name} · {persona.title}
          </option>
        ))}
      </select>
      <span
        data-testid="persona-role"
        className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600"
        title="The session role WebMCP Guard matches role-scoped policy rules against."
      >
        {active.role}
      </span>
      {failed ? (
        <span className="text-[11px] font-medium text-rose-600">switch failed — try again</span>
      ) : null}
    </div>
  );
}
