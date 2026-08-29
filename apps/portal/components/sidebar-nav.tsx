"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV_ITEMS = [
  { href: "/patients", label: "Patients", icon: PeopleIcon },
  { href: "/appointments", label: "Appointments", icon: CalendarIcon },
  { href: "/export", label: "Export", icon: DownloadIcon },
] as const;

/** Primary navigation. Client-side only for the active-route highlight. */
export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={[
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-blue-50 text-blue-800"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            ].join(" ")}
          >
            <Icon />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function iconProps(): { className: string; viewBox: string; "aria-hidden": true } {
  return { className: "h-4 w-4 shrink-0", viewBox: "0 0 20 20", "aria-hidden": true };
}

function PeopleIcon(): ReactNode {
  return (
    <svg {...iconProps()} fill="currentColor">
      <path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 16a5.5 5.5 0 0 1 11 0v.5h-11V16Zm12.2.5c.2-1.6-.3-3.1-1.2-4.2A4 4 0 0 1 18.5 16v.5h-4.8Z" />
    </svg>
  );
}

function CalendarIcon(): ReactNode {
  return (
    <svg {...iconProps()} fill="currentColor">
      <path d="M6 2v1.5h8V2h1.5v1.5H17A1.5 1.5 0 0 1 18.5 5v11A1.5 1.5 0 0 1 17 17.5H3A1.5 1.5 0 0 1 1.5 16V5A1.5 1.5 0 0 1 3 3.5h1.5V2H6ZM3 8v8h14V8H3Z" />
    </svg>
  );
}

function DownloadIcon(): ReactNode {
  return (
    <svg {...iconProps()} fill="currentColor">
      <path d="M9.25 2h1.5v8.19l2.72-2.72 1.06 1.06L10 13.06 5.47 8.53l1.06-1.06 2.72 2.72V2ZM3 14.5h14V17H3v-2.5Z" />
    </svg>
  );
}
