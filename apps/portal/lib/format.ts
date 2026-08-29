/**
 * Display formatting shared by the server and client components.
 *
 * Everything is pinned to UTC on purpose: the seeded schedule is generated in
 * UTC, and a server/client timezone mismatch would otherwise produce React
 * hydration warnings on every appointment row.
 */

const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** `2026-08-29` → `Aug 29, 2026`. Empty string for missing values. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? "" : DATE.format(date);
}

/** ISO datetime → `Aug 29, 2026, 3:00 PM`. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : DATE_TIME.format(date);
}

/** Whole years between a `YYYY-MM-DD` date of birth and `reference`. */
export function ageFromDob(dob: string, reference: Date = new Date()): number | null {
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;

  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = reference.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && reference.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** Whole days from `now` to `value`; negative in the past. */
export function daysUntil(value: string, now: Date = new Date()): number {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return Number.NaN;
  return Math.round((target.getTime() - now.getTime()) / 86_400_000);
}

/** `in 3 days` / `tomorrow` / `today`, for the appointment columns. */
export function describeLeadTime(value: string, now: Date = new Date()): string {
  const days = daysUntil(value, now);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  if (days < 14) return "next week";
  return `in ${Math.round(days / 7)} weeks`;
}
