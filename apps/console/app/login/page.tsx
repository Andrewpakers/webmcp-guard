import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: `Connect — ${SITE.name}`,
};

/** Thin server shell; the form is a client component because the token is. */
export default function LoginPage() {
  return <LoginForm />;
}
