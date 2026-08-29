import type { Metadata } from "next";

import { LogsView } from "@/components/logs/logs-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Audit log — ${SITE.name}`,
};

export default function LogsPage() {
  return <LogsView />;
}
