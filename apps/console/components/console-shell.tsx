"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/components/auth-provider";
import { StatusDot } from "@/components/ui/primitives";
import { maskToken } from "@/lib/auth/session";
import { NAV_ITEMS, SITE } from "@/lib/site";

/**
 * Chrome for every authenticated page: identity, which endpoint this console is
 * pointed at, the disconnect control, and the primary nav.
 *
 * It is also the auth guard. There is no middleware and no server session —
 * the token lives in the tab — so an unauthenticated visit to any route lands
 * here, renders nothing, and is replaced with `/login`.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const { status, token, endpoint, disconnect } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "disconnected") router.replace("/login");
  }, [status, router]);

  if (status !== "connected" || token === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-xs text-slate-500">
        {status === "loading" ? "Restoring session…" : "Redirecting to sign in…"}
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <Link href="/logs" className="flex items-center gap-2">
            <ShieldMark />
            <span className="text-sm font-semibold tracking-tight text-slate-100">
              {SITE.name}
            </span>
          </Link>

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem]">
            <span
              className="flex items-center gap-1.5 text-slate-400"
              title="The portal-mounted guard API this console reads and writes"
            >
              <StatusDot state="ok" />
              <span className="gc-label">endpoint</span>
              <span className="font-mono text-slate-300">{endpoint}</span>
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="gc-label">token</span>
              <span className="font-mono">{maskToken(token)}</span>
            </span>
            <button type="button" className="gc-btn" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-[110rem] gap-1 px-2">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.hint}
                aria-current={active ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-indigo-400 text-slate-100"
                    : "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-[110rem] px-4 py-5">{children}</main>
    </div>
  );
}

function ShieldMark() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5 text-indigo-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.5 7.5 10 4.4-1.5 7.5-5.4 7.5-10v-6L12 2.5Z" />
      <path d="M9 12.2l2.1 2.1L15.4 10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
