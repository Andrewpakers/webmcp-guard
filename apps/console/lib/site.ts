/** Single source of truth for the console's user-facing identity strings. */
export const SITE = {
  id: "webmcp-guard-console",
  name: "WebMCP Guard Console",
} as const;

export function headline(): string {
  return SITE.name;
}

/**
 * Base URL of the portal-mounted guard API. The console keeps no database of
 * its own; everything it renders comes from this endpoint.
 */
export function guardApiUrl(): string {
  return process.env.NEXT_PUBLIC_GUARD_API_URL ?? "http://localhost:3000/api/guard";
}

/**
 * Primary navigation, in the order `docs/06-console-requirements.md` ranks the
 * app's surfaces: the audit log is what sells the story, so it is home.
 */
export const NAV_ITEMS = [
  { href: "/logs", label: "Audit log", hint: "every agent tool call" },
  { href: "/policies", label: "Policies", hint: "rules and the transform matrix" },
  { href: "/dashboard", label: "Dashboard", hint: "24-hour activity" },
  { href: "/settings", label: "Settings", hint: "detectors, tokens, deployment" },
] as const;

/** Shown wherever an operator can change policy (docs/06 §2 asks for this copy). */
export const LIVE_POLICY_NOTICE =
  "Policy changes are live on the next tool call — no redeploy, no restart.";
