import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SITE } from "@/lib/site";

import "./globals.css";

export const metadata: Metadata = {
  title: SITE.name,
  description: "A fictitious patient portal demonstrating WebMCP Guard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
