/**
 * Masking for the before/after payload view
 * (`docs/06-console-requirements.md` §1: "sensitive originals masked by default
 * and a reveal action").
 *
 * The *original* halves of a log entry (`argsBefore`, `resultBefore`) are the
 * pre-tokenization payloads — the real SSNs and MRNs. They render masked until
 * the operator explicitly reveals them, and revealing is itself an audited
 * admin action. Structure is preserved (keys, nesting, array shape) because the
 * shape is the useful, non-sensitive part; every string and number leaf is
 * replaced.
 */

/** What a masked leaf renders as. Fixed width, so length leaks nothing either. */
const MASK = "••••••";

export function maskDeep(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string") return value.length === 0 ? "" : MASK;
  if (typeof value === "number" || typeof value === "bigint") return MASK;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskDeep(item);
    }
    return out;
  }
  return MASK;
}

/** Pretty-printed JSON, or a placeholder when the half was never recorded. */
export function formatJson(value: unknown): string {
  if (value === undefined) return "— not recorded —";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface PayloadViewOptions {
  /** `true` for the original/raw halves; `false` for what the agent received. */
  sensitive: boolean;
  /** Set once the operator has clicked "Reveal original". */
  revealed: boolean;
}

/**
 * The single decision the drawer makes per panel: show the JSON, or show the
 * masked copy of it.
 */
export function payloadView(value: unknown, options: PayloadViewOptions): string {
  const masked = options.sensitive && !options.revealed;
  return formatJson(masked ? maskDeep(value) : value);
}

/** Nothing recorded at all — the drawer renders an empty state instead of `{}`. */
export function isEmptyPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}
