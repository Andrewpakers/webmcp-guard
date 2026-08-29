/** Single source of truth for the console's user-facing identity strings. */
export const SITE = {
  id: "webmcp-guard-console",
  name: "WebMCP Guard Console",
  tagline: "coming online",
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
