/** Single source of truth for the portal's user-facing identity strings. */
export const SITE = {
  /** App identifier used for policy scoping (`match.apps`). */
  id: "lakeside-portal",
  name: "Lakeside Medical",
  tagline: "coming online",
  /** Shown on every screen — all records in this app are synthetic. */
  demoNotice: "Demo environment — all patient records are fictitious.",
} as const;

export function headline(): string {
  return `${SITE.name} — ${SITE.tagline}`;
}
