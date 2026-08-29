"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { CHART_COLORS, type ToolBar, type VerdictDayPoint } from "@/lib/dashboard/series";

/**
 * The dashboard's two charts (`docs/06-console-requirements.md` §3).
 *
 * Both are rendered browser-side only: `ResponsiveContainer` needs a measured
 * box, and there is nothing to prerender anyway — the data arrives from the
 * guard API after the token is in hand.
 *
 * Colour: the verdict stack uses the same three hues as the verdict badges,
 * stepped for this dark surface and checked with the data-viz palette validator
 * (lightness band, chroma floor, CVD separation, contrast). Adjacent-pair CVD
 * separation sits in the band that requires secondary encoding, so both a
 * legend and a naming tooltip are mandatory here, not optional.
 */

const SURFACE = "#0f172a";
const AXIS_TICK = { fill: CHART_COLORS.axis, fontSize: 11 };

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function ChartFrame({ height, children }: { height: number; children: React.ReactElement }) {
  const mounted = useMounted();
  if (!mounted) return <div style={{ height }} aria-hidden />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      {children}
    </ResponsiveContainer>
  );
}

function DarkTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900/95 px-2.5 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-slate-200">{label}</p>
      <ul className="space-y-0.5">
        {payload.map((item) => (
          <li key={String(item.name)} className="flex items-center gap-2 text-slate-400">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: item.color }}
            />
            <span>{item.name}</span>
            <span className="ml-auto font-mono text-slate-200">{String(item.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Calls over time, stacked by what the guard did with them. */
export function CallsByVerdictChart({ data }: { data: VerdictDayPoint[] }) {
  return (
    <ChartFrame height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="28%">
        <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
        <Tooltip content={DarkTooltip} cursor={{ fill: "rgb(148 163 184 / 0.08)" }} />
        <Legend
          iconType="square"
          iconSize={9}
          wrapperStyle={{ fontSize: 11, color: CHART_COLORS.axis, paddingTop: 4 }}
        />
        {/* stroke === surface: a 2px separator between stacked segments. */}
        <Bar
          dataKey="allowed"
          name="allowed"
          stackId="verdict"
          fill={CHART_COLORS.allowed}
          stroke={SURFACE}
          strokeWidth={2}
          maxBarSize={56}
        />
        <Bar
          dataKey="transformed"
          name="transformed"
          stackId="verdict"
          fill={CHART_COLORS.transformed}
          stroke={SURFACE}
          strokeWidth={2}
          maxBarSize={56}
        />
        <Bar
          dataKey="denied"
          name="denied"
          stackId="verdict"
          fill={CHART_COLORS.denied}
          stroke={SURFACE}
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          maxBarSize={56}
        />
      </BarChart>
    </ChartFrame>
  );
}

/** Top tools by call volume — one series, so no legend and one calm hue. */
export function TopToolsChart({ data }: { data: ToolBar[] }) {
  return (
    <ChartFrame height={Math.max(160, data.length * 30 + 40)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        barCategoryGap="30%"
      >
        <CartesianGrid stroke={CHART_COLORS.grid} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, "dataMax"]}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="tool"
          tick={{ ...AXIS_TICK, fontFamily: "var(--font-mono)" }}
          tickLine={false}
          axisLine={false}
          width={150}
        />
        <Tooltip content={DarkTooltip} cursor={{ fill: "rgb(148 163 184 / 0.08)" }} />
        <Bar
          dataKey="count"
          name="calls"
          fill={CHART_COLORS.bar}
          radius={[0, 4, 4, 0]}
          maxBarSize={26}
        />
      </BarChart>
    </ChartFrame>
  );
}
