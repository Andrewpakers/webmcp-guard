import type { SessionContext } from "@webmcp-guard/shared";

/**
 * Lakeside Medical's three mock staff logins (`docs/05` § "Human UI", Phase 6).
 *
 * **These are not authentication.** There is no password, no directory, no SSO —
 * picking a persona in the header sets a signed cookie and nothing else, exactly
 * as `docs/01-project-brief.md` says ("mock role-based login only"; real SSO /
 * OIDC is explicitly out of scope). What the demo needs is a *role* the policy
 * engine can match on and the audit log can record, and that is all this file
 * provides.
 *
 * Safe to import from client components: no Node built-ins here. The signing
 * lives next door in `cookie.ts`, which is server-only.
 */

export interface Persona {
  /** Stable id; also the `userId` on the wire and in the audit log. */
  id: string;
  /** Display name in the header. */
  name: string;
  /** The value `match.roles` compares against. */
  role: string;
  /** Department line shown next to the name — pure set dressing. */
  title: string;
}

/**
 * The cast, in the order the switcher lists them. Ids are lower-case and
 * dash-separated because they are signed as part of a dot-delimited payload
 * (`cookie.ts`) — a dot in an id would make that payload ambiguous.
 */
export const PERSONAS: readonly Persona[] = [
  {
    id: "dr-reyes",
    name: "Dr. Alicia Reyes",
    role: "physician",
    title: "Internal Medicine",
  },
  {
    id: "nurse-okafor",
    name: "Nurse Chidi Okafor",
    role: "nursing",
    title: "Nursing",
  },
  {
    id: "sam-levin",
    name: "Sam Levin",
    role: "billing",
    title: "Billing Office",
  },
] as const;

/**
 * Who you are before you choose. Dr. Reyes, because the portal's header has said
 * "Signed in as Dr. Alicia Reyes" since Phase 1 and because a judge who never
 * touches the switcher should land in the clinical (least surprising) view.
 */
export const DEFAULT_PERSONA_ID = "dr-reyes";

export const DEFAULT_PERSONA: Persona = personaOrDefault(DEFAULT_PERSONA_ID);

/** The persona with this id, or `undefined`. */
export function findPersona(id: string | undefined | null): Persona | undefined {
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return PERSONAS.find((persona) => persona.id === trimmed);
}

/** The persona with this id, or {@link DEFAULT_PERSONA}. */
export function personaOrDefault(id: string | undefined | null): Persona {
  const found = findPersona(id);
  if (found !== undefined) return found;
  const fallback = PERSONAS.find((persona) => persona.id === DEFAULT_PERSONA_ID);
  // PERSONAS is a literal in this file; this can only fire if someone edits the
  // default id without editing the list.
  if (fallback === undefined) throw new Error(`No persona "${DEFAULT_PERSONA_ID}" in PERSONAS.`);
  return fallback;
}

/** The `{ userId, role }` shape the guard wire (and the audit log) carries. */
export function sessionContextOf(persona: Persona): SessionContext {
  return { userId: persona.id, role: persona.role };
}

/** "Dr. Alicia Reyes · Internal Medicine" — the header line and the menu label. */
export function personaLabel(persona: Persona): string {
  return `${persona.name} · ${persona.title}`;
}
