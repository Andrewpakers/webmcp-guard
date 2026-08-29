import type { LogAgentInfo, PostureSnapshot } from "@webmcp-guard/shared";

import { truncate } from "./http";

/**
 * Flattens the SDK's posture snapshot into the denormalised `agent` block of a
 * log entry, so the console can render "who called this" without joining
 * anything.
 *
 * Every field here is **advisory**: UA Client Hints are trivially spoofable and
 * the snapshot is assembled by the page itself (`docs/03-architecture.md`
 * threat model). Treat it as reporting, never as authentication.
 */

/** Client Hints pad the brand list with a GREASE entry; it is not a browser. */
const GREASE_BRAND = /not.?a.?brand/i;

const MAX_AGENT_ID = 64;
const MAX_BRAND = 64;
const MAX_PLATFORM = 64;
const MAX_USER_AGENT = 512;

/** Picks the most specific real brand: "Google Chrome" over "Chromium". */
export function pickBrand(
  brands: PostureSnapshot["brands"],
): { brand: string; version: string } | undefined {
  if (brands === undefined || brands.length === 0) return undefined;
  const real = brands.filter((entry) => !GREASE_BRAND.test(entry.brand));
  return real.find((entry) => entry.brand !== "Chromium") ?? real[0] ?? undefined;
}

export function agentInfoFromPosture(posture: PostureSnapshot | undefined): LogAgentInfo {
  if (posture === undefined) return {};

  const brand = pickBrand(posture.brands);

  return {
    ...(posture.agentId !== undefined ? { agentId: truncate(posture.agentId, MAX_AGENT_ID) } : {}),
    ...(brand !== undefined
      ? {
          browserBrand: truncate(brand.brand, MAX_BRAND),
          browserVersion: truncate(brand.version, MAX_BRAND),
        }
      : {}),
    ...(posture.platform !== undefined
      ? { platform: truncate(posture.platform, MAX_PLATFORM) }
      : {}),
    ...(posture.userAgent !== undefined
      ? { userAgent: truncate(posture.userAgent, MAX_USER_AGENT) }
      : {}),
    isSecureContext: posture.isSecureContext,
  };
}
