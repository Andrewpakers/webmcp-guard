import { describe, expect, it } from "vitest";

import { buildQueryString } from "@/lib/api/client";
import { logQueryParams } from "@/lib/api/guard-client";

import {
  EMPTY_LOG_FILTERS,
  LOG_PAGE_SIZE,
  datetimeLocalToIso,
  hasActiveFilters,
  isoHoursAgo,
  isoToDatetimeLocal,
  logFiltersToQuery,
  pageRange,
  type LogFilterState,
} from "./query";

describe("logFiltersToQuery", () => {
  it("asks only for a page when nothing is filtered", () => {
    expect(logFiltersToQuery(EMPTY_LOG_FILTERS)).toEqual({ limit: LOG_PAGE_SIZE });
  });

  it("maps every control onto its LogQuery field", () => {
    const filters: LogFilterState = {
      tool: "  export_records  ",
      verdict: "deny",
      dataClass: "ssn",
      agent: " chatgpt-atlas ",
      since: "",
      until: "",
    };

    expect(logFiltersToQuery(filters)).toEqual({
      tool: "export_records",
      verdict: "deny",
      dataClass: "ssn",
      agentId: "chatgpt-atlas",
      limit: LOG_PAGE_SIZE,
    });
  });

  it("resolves datetime-local bounds through the browser's zone into UTC", () => {
    const query = logFiltersToQuery({
      ...EMPTY_LOG_FILTERS,
      since: "2026-08-29T09:00",
      until: "2026-08-29T17:30",
    });

    expect(query.since).toBe(new Date("2026-08-29T09:00").toISOString());
    expect(query.until).toBe(new Date("2026-08-29T17:30").toISOString());
    expect(query.since?.endsWith("Z")).toBe(true);
  });

  it("prefers a cursor over an offset, and omits offset 0", () => {
    expect(logFiltersToQuery(EMPTY_LOG_FILTERS, { offset: 0 })).toEqual({ limit: LOG_PAGE_SIZE });
    expect(logFiltersToQuery(EMPTY_LOG_FILTERS, { offset: 50 })).toMatchObject({ offset: 50 });
    expect(logFiltersToQuery(EMPTY_LOG_FILTERS, { offset: 50, cursor: "abc" })).toMatchObject({
      cursor: "abc",
    });
    expect(logFiltersToQuery(EMPTY_LOG_FILTERS, { offset: 50, cursor: "abc" }).offset).toBeUndefined();
  });

  it("produces the query string GET /logs actually parses", () => {
    const query = logFiltersToQuery(
      { ...EMPTY_LOG_FILTERS, tool: "get_patient", agent: "atlas", verdict: "allow" },
      { limit: 25, offset: 25 },
    );

    expect(buildQueryString(logQueryParams(query))).toBe(
      "?tool=get_patient&verdict=allow&agent=atlas&limit=25&offset=25",
    );
  });
});

describe("datetime-local conversion", () => {
  it("round-trips a local wall-clock value", () => {
    const local = "2026-08-29T14:30";
    expect(isoToDatetimeLocal(datetimeLocalToIso(local))).toBe(local);
  });

  it("ignores blank and unparseable input", () => {
    expect(datetimeLocalToIso("")).toBeUndefined();
    expect(datetimeLocalToIso("   ")).toBeUndefined();
    expect(datetimeLocalToIso("not-a-date")).toBeUndefined();
    expect(isoToDatetimeLocal(undefined)).toBe("");
    expect(isoToDatetimeLocal("nonsense")).toBe("");
  });
});

describe("filter helpers", () => {
  it("detects an active filter", () => {
    expect(hasActiveFilters(EMPTY_LOG_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_LOG_FILTERS, tool: " " })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_LOG_FILTERS, verdict: "deny" })).toBe(true);
  });

  it("describes the visible slice of the result set", () => {
    expect(pageRange(0, 50, 231)).toEqual([1, 50]);
    expect(pageRange(200, 31, 231)).toEqual([201, 231]);
    expect(pageRange(0, 0, 0)).toEqual([0, 0]);
  });

  it("computes the dashboard's 24h lower bound", () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    expect(isoHoursAgo(24, now)).toBe("2026-08-28T12:00:00.000Z");
  });
});
