import { SITE, headline } from "@/lib/site";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <p className="text-xs font-medium tracking-widest text-teal-700 uppercase dark:text-teal-400">
        Patient Portal
      </p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{headline()}</h1>
      <p className="text-slate-600 dark:text-slate-400">
        Protected by WebMCP Guard. Patient records, search, and visit notes arrive in a later build
        phase.
      </p>
      <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        {SITE.demoNotice}
      </p>
    </main>
  );
}
