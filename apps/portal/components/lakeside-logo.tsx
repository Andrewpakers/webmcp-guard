/**
 * The Lakeside Medical mark: a clinical cross sitting above two lake ripples.
 * Inline SVG rather than a file so it inherits `currentColor` and needs no
 * network request — the demo runs on a free Render instance.
 */
export function LakesideLogo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="Lakeside Medical"
      className={className}
      fill="none"
    >
      <rect width="32" height="32" rx="8" className="fill-blue-700" />
      <path d="M14 7h4v5h5v4h-5v5h-4v-5H9v-4h5V7Z" className="fill-white" />
      <path
        d="M6 23.5c2-1.6 3.5-1.6 5.5 0s3.5 1.6 5.5 0 3.5-1.6 5.5 0 2.4 1.3 3.5.6"
        className="stroke-sky-300"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Logo plus wordmark, used in the sidebar header. */
export function LakesideWordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <LakesideLogo />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight text-slate-900">
          Lakeside Medical
        </div>
        <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
          Patient Portal
        </div>
      </div>
    </div>
  );
}
