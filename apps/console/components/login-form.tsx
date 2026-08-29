"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth-provider";
import { SITE } from "@/lib/site";

/**
 * The console's only sign-in: one admin bearer token, validated against
 * `GET /stats` before it is stored (`docs/06-console-requirements.md`).
 *
 * Deliberately not a password field over a user database — there is no user
 * database. One shared admin token is the documented model
 * (docs/06 non-goals: no user management, no RBAC for admins).
 */
export function LoginForm() {
  const { status, connect, notice, clearNotice } = useAuth();
  const router = useRouter();

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already connected (a bookmark to /login, or a second tab): go straight in.
  useEffect(() => {
    if (status === "connected") router.replace("/logs");
  }, [status, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    clearNotice();

    const result = await connect(token);
    setBusy(false);

    if (result.ok) {
      router.replace("/logs");
      return;
    }
    setError(result.error ?? "Could not connect.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div>
        <p className="gc-label text-indigo-300">WebMCP Guard</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">{SITE.name}</h1>
        <p className="mt-2 text-sm text-slate-400">
          Policy, posture and the audit trail for the agent channel. Connect with the deployment&rsquo;s
          admin token to continue.
        </p>
      </div>

      {notice !== null && (
        <p className="rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          {notice}
        </p>
      )}

      <form onSubmit={onSubmit} className="gc-card flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1.5">
          <span className="gc-label">Admin token</span>
          <input
            className="gc-input font-mono"
            type="password"
            name="admin-token"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            placeholder="GUARD_ADMIN_TOKEN"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>

        {error !== null && (
          <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        )}

        <button type="submit" className="gc-btn gc-btn-primary py-2" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>

        <p className="text-[0.6875rem] leading-relaxed text-slate-500">
          The token is kept in this tab&rsquo;s <code className="font-mono">sessionStorage</code> —
          never a cookie, never <code className="font-mono">localStorage</code> — and is sent as a
          bearer header to the portal&rsquo;s guard API. Closing the tab signs you out.
        </p>
      </form>
    </main>
  );
}
