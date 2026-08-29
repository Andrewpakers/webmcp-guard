/**
 * Minimal RFC 4180 CSV writer. Kept separate from the repository so the escaping
 * rules can be unit-tested without touching SQLite.
 */

/**
 * Quotes a single field. A field is quoted when it contains a comma, a quote, a
 * newline or leading/trailing whitespace; embedded quotes are doubled.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const needsQuotes = /[",\r\n]/.test(raw) || raw !== raw.trim();
  if (!needsQuotes) return raw;
  return `"${raw.replaceAll('"', '""')}"`;
}

/** Joins one row of already-stringifiable values. */
export function toCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvValue).join(",");
}

/** Renders a header row plus body rows, CRLF-terminated as the spec prescribes. */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [toCsvRow(header), ...rows.map(toCsvRow)].join("\r\n") + "\r\n";
}
