import type { BrowserBrand } from "./wire";

/**
 * UA-string parsing, used as the **fallback** for UA Client Hints.
 *
 * `navigator.userAgentData` is Chromium-only and secure-context-only, so plenty
 * of real environments (Safari, Firefox, ChatGPT's in-app browser, anything on
 * plain http) report nothing but a UA string. Both halves of WebMCP Guard need
 * to derive the same `{brand, version}` pairs from it — the SDK when it builds a
 * posture snapshot, the server when it evaluates a `browser` posture matcher
 * against a snapshot some other client produced — so the parser lives here
 * rather than being written twice and drifting.
 *
 * Honesty rule (`docs/03-architecture.md` threat model): a UA string is a
 * self-report from the page. Everything here is advisory, spoofable in one line
 * of JavaScript, and must never be treated as authentication.
 */

interface UserAgentPattern {
  /** First capture group is the major version. */
  pattern: RegExp;
  /**
   * The brands this UA implies, most specific first. Chromium-family browsers
   * report *two* brands through Client Hints ("Google Chrome" and "Chromium"),
   * and a fallback that reported only one would make a policy written against
   * Client Hints stop matching the moment a browser hides them.
   */
  brands: readonly string[];
}

/**
 * Ordered, most specific first: every Chromium derivative also carries
 * `Chrome/…` in its UA, and Chrome itself carries `Safari/537.36`.
 */
const USER_AGENT_PATTERNS: readonly UserAgentPattern[] = [
  { pattern: /\bEdg(?:A|iOS)?\/(\d+)/, brands: ["Microsoft Edge", "Chromium"] },
  { pattern: /\bOPR\/(\d+)/, brands: ["Opera", "Chromium"] },
  { pattern: /\bHeadlessChrome\/(\d+)/, brands: ["HeadlessChrome", "Chromium"] },
  { pattern: /\bChrome\/(\d+)/, brands: ["Google Chrome", "Chromium"] },
  { pattern: /\bFirefox\/(\d+)/, brands: ["Firefox"] },
  { pattern: /\bVersion\/(\d+)[\d.]*\s+(?:Mobile\/\S+\s+)?Safari\//, brands: ["Safari"] },
];

/** Longest UA string this parser will look at, to bound regex work. */
const MAX_USER_AGENT = 1024;

/**
 * `{brand, version}` pairs implied by a UA string, or `[]` when nothing is
 * recognised. Never throws, whatever it is handed.
 */
export function parseUserAgentBrands(userAgent: unknown): BrowserBrand[] {
  if (typeof userAgent !== "string" || userAgent.length === 0) return [];
  const value = userAgent.slice(0, MAX_USER_AGENT);

  for (const { pattern, brands } of USER_AGENT_PATTERNS) {
    const match = pattern.exec(value);
    if (match === null) continue;
    const version = match[1];
    return brands.map((brand) => ({ brand, version }));
  }
  return [];
}

/**
 * The integer major version of a Client-Hints version string (`"151"`,
 * `"151.0.7049.42"`), or `null` when it does not start with digits.
 *
 * `null` is a real answer, not an error: a rule with a version range cannot be
 * decided against an unparsable version, and the engine refuses to guess.
 */
export function brandMajorVersion(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const match = /^\s*(\d{1,6})/.exec(version);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Brand comparison for policy matching: trimmed, case-insensitive, exact.
 *
 * Deliberately *not* a substring match. `{ brand: "Chrome" }` matching
 * "Chromium" would silently widen every rule an administrator writes; a policy
 * that means several brands lists several matchers instead (see the seeded
 * posture pack).
 */
export function sameBrand(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
