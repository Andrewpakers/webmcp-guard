import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Dashboard — ${SITE.name}`,
};

export default function DashboardPage() {
  return <DashboardView />;
}
