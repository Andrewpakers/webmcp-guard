import { redirect } from "next/navigation";

/**
 * The console has no landing page: the audit log is home
 * (`docs/06-console-requirements.md` priority order). `/logs` is behind the
 * shell's auth guard, which sends an unconnected operator to `/login`.
 */
export default function Home() {
  redirect("/logs");
}
