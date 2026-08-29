"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Export controls. The filter box mirrors the patient list's, and the count
 * updates live from `/api/portal/search` so nobody downloads 60 records
 * thinking they asked for 20.
 */
export function ExportPanel({ initialTotal }: { initialTotal: number }) {
  const [text, setText] = useState("");
  const [condition, setCondition] = useState("");
  const [count, setCount] = useState(initialTotal);
  const [counting, setCounting] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      const id = ++requestId.current;
      setCounting(true);

      const params = new URLSearchParams({ limit: "1" });
      if (text.trim()) params.set("text", text.trim());
      if (condition.trim()) params.set("condition", condition.trim());

      void fetch(`/api/portal/search?${params.toString()}`)
        .then((response) => response.json() as Promise<{ total?: number }>)
        .then((payload) => {
          if (id === requestId.current) setCount(payload.total ?? 0);
        })
        .catch(() => {
          if (id === requestId.current) setCount(0);
        })
        .finally(() => {
          if (id === requestId.current) setCounting(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [text, condition]);

  const params = new URLSearchParams({ limit: "500" });
  if (text.trim()) params.set("text", text.trim());
  if (condition.trim()) params.set("condition", condition.trim());
  const href = `/api/portal/export?${params.toString()}`;

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">Filter by name / MRN</span>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Leave blank for the whole roster"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-700">Filter by condition</span>
          <input
            type="search"
            value={condition}
            onChange={(event) => setCondition(event.target.value)}
            placeholder="e.g. hypertension"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <p className="text-sm text-slate-600" aria-live="polite">
          {counting ? "Counting…" : null}
          {!counting ? (
            <>
              <span className="text-2xl font-semibold text-slate-900">{count}</span>
              <span className="pl-2">patient record{count === 1 ? "" : "s"} will be exported</span>
            </>
          ) : null}
        </p>
        <a
          href={href}
          download
          className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800"
        >
          Download CSV
        </a>
      </div>
    </div>
  );
}
