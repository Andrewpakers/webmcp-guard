import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AgentActivityDrawer } from "@/components/agent-activity-drawer";
import { LakesideWordmark } from "@/components/lakeside-logo";
import { SidebarNav } from "@/components/sidebar-nav";
import { WebMcpStatusChip } from "@/components/webmcp-status-chip";
import { WebMcpTools } from "@/components/webmcp-tools";
import { SITE } from "@/lib/site";

import "./globals.css";

export const metadata: Metadata = {
  title: SITE.name,
  description: "A fictitious patient portal demonstrating WebMCP Guard.",
};

/**
 * App shell: fixed sidebar, header with the WebMCP Guard status chip and the
 * Agent Activity drawer, and the synthetic-data notice pinned to the bottom of
 * every page (docs/05).
 *
 * `<WebMcpTools />` sits here so the seven guarded tools are registered on every
 * route — an agent should not have to navigate anywhere before it can search.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
        <WebMcpTools />
        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5 md:flex">
            <Link href="/patients" className="mb-6 block rounded-md">
              <LakesideWordmark />
            </Link>
            <SidebarNav />
            <div className="mt-auto space-y-1 border-t border-slate-100 pt-4 text-[11px] text-slate-400">
              <p className="font-medium text-slate-500">Lakeside Medical Group</p>
              <p>1420 Harborview Ave, Suite 300</p>
              <p>Build {SITE.buildLabel}</p>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
              <div className="flex items-center gap-3 md:hidden">
                <LakesideWordmark />
              </div>
              <div className="hidden text-sm text-slate-500 md:block">
                Signed in as <span className="font-medium text-slate-700">Dr. Alicia Reyes</span> ·
                Internal Medicine
              </div>
              <div className="flex items-center gap-3">
                <WebMcpStatusChip />
                <AgentActivityDrawer />
              </div>
            </header>

            <main className="min-w-0 flex-1 px-4 py-6 sm:px-6">{children}</main>

            <footer className="border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-center text-xs font-medium text-amber-900 sm:px-6">
              {SITE.demoNotice}
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
