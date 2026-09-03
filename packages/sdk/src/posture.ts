import { parseUserAgentBrands, type PostureSnapshot } from "@webmcp-guard/shared";

import { guardGlobals } from "./webmcp";

/**
 * The client's best-effort report on the environment the call came from.
 *
 * Honesty rule from `docs/04` behavior 5 and `docs/03`'s threat model: every
 * field here is spoofable by anyone who can run script in the page. The client
 * *reports*, the server *decides*. Nothing in this file is a security control,
 * and nothing in this repo may describe `agentId` as identification — it is a
 * guess made from a string the caller controls.
 */

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Viewport dimensions must be non-negative integers on the wire. */
function asDimension(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/** Client Hints brands, keeping only entries that are actually `{brand, version}`. */
function readBrands(value: unknown): Array<{ brand: string; version: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const brands: Array<{ brand: string; version: string }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const brand = asString((entry as { brand?: unknown }).brand);
    const version = asString((entry as { version?: unknown }).version);
    if (brand !== undefined && version !== undefined) brands.push({ brand, version });
  }
  return brands.length > 0 ? brands : undefined;
}

/**
 * Substrings that suggest which agent is driving the page, checked **in order,
 * most specific first** — ChatGPT's Atlas browser also says "ChatGPT", so the
 * general marker has to come last or it would swallow the specific one.
 *
 * Extending this list is the intended way to teach WebMCP Guard about a new
 * agent: add a `{ marker, id }` pair, and `{kind: "agent", id}` policy rules
 * start matching it. Nothing else has to change.
 *
 * These are *conventions*, not credentials. Any page script can set
 * `navigator.userAgent` in a test harness, and any agent can omit its marker.
 * A rule written against an agent id is a routing decision ("treat this fleet
 * differently"), never an authorization decision.
 */
export const AGENT_UA_MARKERS: readonly { marker: string; id: string }[] = [
  { marker: "atlas", id: "chatgpt-atlas" },
  { marker: "chatgpt", id: "chatgpt-inapp" },
  // Any Claude-branded surface (a Claude browser UA or a "Claude" Client-Hints
  // brand). An agent driving a stock browser (e.g. a Chrome extension) leaves
  // no marker at all and shows up as "unknown" — which is exactly what the
  // deny-unknown-agent posture rule is for.
  { marker: "claude", id: "claude" },
];

/**
 * Best-effort agent guess from the UA string and the Client-Hints brand names.
 *
 * Both are searched because a Chromium-based agent browser may announce itself
 * as a *brand* ("ChatGPT";v="1") rather than in the UA string, and either one
 * is as (un)trustworthy as the other.
 *
 * Returns `undefined` when nothing matches — which is a real answer the policy
 * engine can act on (`{kind: "unknown"}`), not a failure.
 */
export function guessAgentId(
  userAgent: string | undefined,
  brands: readonly { brand: string }[] | undefined,
): string | undefined {
  const haystack = [userAgent ?? "", ...(brands ?? []).map((entry) => entry.brand)]
    .join(" ")
    .toLowerCase();
  if (haystack.trim().length === 0) return undefined;

  for (const { marker, id } of AGENT_UA_MARKERS) {
    if (haystack.includes(marker)) return id;
  }
  return undefined;
}

/**
 * Builds a snapshot that always satisfies `PostureSnapshotSchema`, whatever the
 * host environment looks like — a snapshot the server rejects would fail every
 * call closed, which is a denial-of-service, not a security win.
 *
 * `isSecureContext` defaults to `false` when the global is missing: claiming
 * "not secure" when we cannot tell is the fail-safe direction, since posture
 * rules are written to *restrict* insecure contexts.
 */
export function collectPostureSnapshot(): PostureSnapshot {
  const globals = guardGlobals();
  const navigator = globals.navigator;

  const snapshot: PostureSnapshot = {
    isSecureContext: globals.isSecureContext === true,
    timestamp: new Date().toISOString(),
  };

  const userAgent = asString(navigator?.userAgent);
  if (userAgent !== undefined) snapshot.userAgent = userAgent;

  const userAgentData = navigator?.userAgentData;
  if (userAgentData) {
    const brands = readBrands(userAgentData.brands);
    if (brands !== undefined) snapshot.brands = brands;

    const platform = asString(userAgentData.platform);
    if (platform !== undefined) snapshot.platform = platform;

    if (typeof userAgentData.mobile === "boolean") snapshot.mobile = userAgentData.mobile;
  }

  /**
   * UA Client Hints are Chromium-only and secure-context-only, so Safari,
   * Firefox and anything on plain http report no brands at all. Parsing the UA
   * string fills the same three fields the server's `browser` posture matcher
   * reads, using the shared parser both halves of the guard agree on — so a
   * version rule means the same thing wherever the call came from.
   *
   * Only ever a *fallback*: real Client Hints win, and nothing is invented
   * beyond the schema's existing fields (`docs/04` behavior 5).
   */
  if (snapshot.brands === undefined) {
    const parsed = parseUserAgentBrands(snapshot.userAgent);
    if (parsed.length > 0) snapshot.brands = parsed;
  }

  const agentId = guessAgentId(snapshot.userAgent, snapshot.brands);
  if (agentId !== undefined) snapshot.agentId = agentId;

  const width = asDimension(globals.innerWidth);
  const height = asDimension(globals.innerHeight);
  if (width !== undefined && height !== undefined) snapshot.viewport = { width, height };

  return snapshot;
}
