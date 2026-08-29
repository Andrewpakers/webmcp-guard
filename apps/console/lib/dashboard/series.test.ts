import type { GuardStats } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { CHART_COLORS, callsByDay, formatDay, isEmptyStats, statCards, topTools } from "./series";

function stats(overrides: Partial<GuardStats> = {}): GuardStats {
  return {
    totalCalls: 0,
    denied: 0,
    transformed: 0,
    uniqueAgents: 0,
    byTool: [],
    byDay: [],
    ...overrides,
  };
}

describe("callsByDay", () => {
  it("derives the allowed segment as the remainder of the day's total", () => {
    const series = callsByDay(
      stats({ byDay: [{ day: "2026-08-29", total: 10, denied: 2, transformed: 3 }] }),
    );

    expect(series).toEqual([
      { day: "2026-08-29", label: "Aug 29", allowed: 5, transformed: 3, denied: 2, total: 10 },
    ]);
  });

  it("never renders a negative segment", () => {
    const series = callsByDay(
      stats({ byDay: [{ day: "2026-08-29", total: 4, denied: 3, transformed: 3 }] }),
    );
    expect(series[0].allowed).toBe(0);
  });

  it("keeps the server's ascending day order", () => {
    const series = callsByDay(
      stats({
        byDay: [
          { day: "2026-08-27", total: 1, denied: 0, transformed: 0 },
          { day: "2026-08-28", total: 2, denied: 0, transformed: 0 },
        ],
      }),
    );
    expect(series.map((point) => point.day)).toEqual(["2026-08-27", "2026-08-28"]);
  });
});

describe("formatDay", () => {
  it("formats a UTC day key without going through Date (no timezone drift)", () => {
    expect(formatDay("2026-01-01")).toBe("Jan 1");
    expect(formatDay("2026-12-31")).toBe("Dec 31");
  });

  it("passes anything unexpected through untouched", () => {
    expect(formatDay("today")).toBe("today");
    expect(formatDay("2026-13-01")).toBe("2026-13-01");
  });
});

describe("topTools", () => {
  it("passes a short list through", () => {
    const byTool = [
      { tool: "search_patients", count: 9 },
      { tool: "get_patient", count: 4 },
    ];
    expect(topTools(stats({ byTool }))).toEqual(byTool);
  });

  it("folds the tail into one `other` bar rather than dropping it", () => {
    const byTool = Array.from({ length: 12 }, (_unused, index) => ({
      tool: `tool_${index}`,
      count: 12 - index,
    }));

    const bars = topTools(stats({ byTool }), 4);

    expect(bars).toHaveLength(4);
    expect(bars.slice(0, 3).map((bar) => bar.tool)).toEqual(["tool_0", "tool_1", "tool_2"]);
    expect(bars[3]).toEqual({ tool: "other (9)", count: 9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1 });
  });

  it("does not alias the stats object", () => {
    const source = stats({ byTool: [{ tool: "a", count: 1 }] });
    const bars = topTools(source);
    bars[0].count = 99;
    expect(source.byTool[0].count).toBe(1);
  });
});

describe("statCards", () => {
  it("reports the four dashboard counters in order", () => {
    const cards = statCards(
      stats({ totalCalls: 31, denied: 4, transformed: 12, uniqueAgents: 2 }),
    );
    expect(cards.map((card) => [card.key, card.value])).toEqual([
      ["calls", 31],
      ["denied", 4],
      ["transformed", 12],
      ["agents", 2],
    ]);
  });
});

describe("isEmptyStats", () => {
  it("is true only when nothing happened in the window", () => {
    expect(isEmptyStats(stats())).toBe(true);
    expect(isEmptyStats(stats({ totalCalls: 1 }))).toBe(false);
    expect(isEmptyStats(stats({ byTool: [{ tool: "a", count: 1 }] }))).toBe(false);
  });
});

describe("CHART_COLORS", () => {
  it("uses the validated dark-surface hues for the verdict stack", () => {
    expect(CHART_COLORS.allowed).toBe("#199e70");
    expect(CHART_COLORS.transformed).toBe("#0e93cf");
    expect(CHART_COLORS.denied).toBe("#e66767");
  });
});
