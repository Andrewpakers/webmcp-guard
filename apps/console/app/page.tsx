import { headline } from "@/lib/site";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <p className="text-xs font-medium tracking-widest text-teal-400 uppercase">WebMCP Guard</p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{headline()}</h1>
      <p className="text-slate-400">
        Coming online. Policies, the audit trail, and the dashboard arrive in a later build phase.
      </p>
    </main>
  );
}
