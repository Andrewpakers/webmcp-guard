import type { PostureSnapshot } from "@webmcp-guard/shared";

import { guardGlobals } from "./webmcp";

/**
 * The client's best-effort report on the environment the call came from.
 *
 * Honesty rule from `docs/04` behavior 5 and `docs/03`'s threat model: every
 * field here is spoofable by anyone who can run script in the page. The client
 * *reports*, the server *decides*. Nothing in this file is a security control.
 *
 * Phase 2 collects the deterministic basics. The best-effort agent guess
 * (`agentId`) and UA-string brand parsing land with the posture rule pack in
 * Phase 5.
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

  const width = asDimension(globals.innerWidth);
  const height = asDimension(globals.innerHeight);
  if (width !== undefined && height !== undefined) snapshot.viewport = { width, height };

  return snapshot;
}
