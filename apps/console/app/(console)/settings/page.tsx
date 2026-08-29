import type { Metadata } from "next";

import { SettingsView } from "@/components/settings/settings-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Settings — ${SITE.name}`,
};

export default function SettingsPage() {
  return <SettingsView />;
}
