import {
  parseUserAgentBrands,
  type BrowserBrand,
  type LogAgentInfo,
  type PostureSnapshot,
} from "@webmcp-guard/shared";

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

/**
 * Every brand a `browser` posture matcher may be tested against: the Client
 * Hints list with the GREASE entry removed, or — when the client sent none —
 * whatever the UA string implies.
 *
 * The server re-derives the UA fallback rather than trusting the SDK to have
 * done it, because a posture snapshot is just JSON on the wire: it may come
 * from an older SDK, a hand-rolled client, or a browser that hides Client
 * Hints. Deriving it here means one rule (`brand: "Chromium", maxVersion: 148`)
 * behaves the same for all of them.
 *
 * It stays a *fallback*, not a supplement: when a client reports Client Hints,
 * those are the brands, and the server does not second-guess them with a
 * regex.
 */
export function postureBrands(posture: PostureSnapshot): BrowserBrand[] {
  const reported = (posture.brands ?? []).filter((entry) => !GREASE_BRAND.test(entry.brand));
  if (reported.length > 0) return reported;
  return parseUserAgentBrands(posture.userAgent);
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
