/** Single source of truth for the portal's user-facing identity strings. */
export const SITE = {
  /** App identifier used for policy scoping (`match.apps`). */
  id: "lakeside-portal",
  name: "Lakeside Medical",
  tagline: "coming online",
  /** Shown on every screen — all records in this app are synthetic. */
  demoNotice: "Demo environment — all patient records are synthetic.",
  /** Cosmetic build string in the sidebar footer; keeps the shell looking like real software. */
  buildLabel: "2026.9.0-demo",
} as const;

export function headline(): string {
  return `${SITE.name} — ${SITE.tagline}`;
}
