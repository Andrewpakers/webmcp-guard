import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SITE } from "@/lib/site";

import "./globals.css";

export const metadata: Metadata = {
  title: SITE.name,
  description: "Policy management and audit trail for WebMCP Guard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
