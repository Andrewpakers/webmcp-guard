import { describe, expect, it } from "vitest";

import { ageFromDob, daysUntil, describeLeadTime, formatDate, formatDateTime } from "./format";

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("formatDate", () => {
  it("renders an ISO date in UTC", () => {
    expect(formatDate("2026-08-29")).toBe("Aug 29, 2026");
  });

  it("renders an ISO datetime as a date", () => {
    expect(formatDate("2026-08-29T23:30:00.000Z")).toBe("Aug 29, 2026");
  });

  it("is empty for missing or unparseable values", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("not-a-date")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("includes the time in UTC so server and client agree", () => {
    expect(formatDateTime("2026-08-29T15:30:00.000Z")).toBe("Aug 29, 2026, 3:30 PM");
  });
});

describe("ageFromDob", () => {
  it("counts whole years", () => {
    expect(ageFromDob("1980-01-01", NOW)).toBe(46);
  });

  it("does not count a birthday that has not happened yet", () => {
    expect(ageFromDob("1980-12-31", NOW)).toBe(45);
  });

  it("counts a birthday that is today", () => {
    expect(ageFromDob("1980-08-29", NOW)).toBe(46);
  });

  it("returns null for junk", () => {
    expect(ageFromDob("nope", NOW)).toBeNull();
  });
});

describe("daysUntil / describeLeadTime", () => {
  it("measures forward in whole days", () => {
    expect(daysUntil("2026-09-01T12:00:00.000Z", NOW)).toBe(3);
    expect(daysUntil("2026-08-27T12:00:00.000Z", NOW)).toBe(-2);
  });

  it("describes the near future in words", () => {
    expect(describeLeadTime("2026-08-29T18:00:00.000Z", NOW)).toBe("today");
    expect(describeLeadTime("2026-08-30T12:00:00.000Z", NOW)).toBe("tomorrow");
    expect(describeLeadTime("2026-09-01T12:00:00.000Z", NOW)).toBe("in 3 days");
    expect(describeLeadTime("2026-09-07T12:00:00.000Z", NOW)).toBe("next week");
    expect(describeLeadTime("2026-09-26T12:00:00.000Z", NOW)).toBe("in 4 weeks");
  });
});
