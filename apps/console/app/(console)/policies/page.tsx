import type { Metadata } from "next";

import { PoliciesView } from "@/components/policies/policies-view";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Policies — ${SITE.name}`,
};

export default function PoliciesPage() {
  return <PoliciesView />;
}
