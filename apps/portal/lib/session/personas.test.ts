import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_ID,
  PERSONAS,
  findPersona,
  personaLabel,
  personaOrDefault,
  sessionContextOf,
} from "./personas";

describe("PERSONAS", () => {
  it("is the cast docs/05 names, with the roles policy matches on", () => {
    expect(PERSONAS.map((persona) => [persona.id, persona.name, persona.role])).toEqual([
      ["dr-reyes", "Dr. Alicia Reyes", "physician"],
      ["nurse-okafor", "Nurse Chidi Okafor", "nursing"],
      ["sam-levin", "Sam Levin", "billing"],
    ]);
  });

  it("uses ids that survive the dot-delimited signed payload", () => {
    for (const persona of PERSONAS) {
      expect(persona.id).toMatch(/^[a-z0-9-]+$/);
      expect(persona.role).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("defaults to Dr. Reyes, matching the header copy the portal has always shown", () => {
    expect(DEFAULT_PERSONA_ID).toBe("dr-reyes");
    expect(DEFAULT_PERSONA.name).toBe("Dr. Alicia Reyes");
  });
});

describe("findPersona / personaOrDefault", () => {
  it("finds by id and trims", () => {
    expect(findPersona("sam-levin")?.role).toBe("billing");
    expect(findPersona("  nurse-okafor  ")?.role).toBe("nursing");
  });

  it("returns undefined for anything unknown", () => {
    expect(findPersona("dr-nobody")).toBeUndefined();
    expect(findPersona(undefined)).toBeUndefined();
    expect(findPersona(null)).toBeUndefined();
    expect(findPersona("")).toBeUndefined();
  });

  it("falls back to the default persona", () => {
    expect(personaOrDefault("dr-nobody")).toEqual(DEFAULT_PERSONA);
    expect(personaOrDefault(undefined)).toEqual(DEFAULT_PERSONA);
    expect(personaOrDefault("sam-levin").id).toBe("sam-levin");
  });
});

describe("sessionContextOf", () => {
  it("is exactly the { userId, role } the guard wire carries", () => {
    expect(sessionContextOf(DEFAULT_PERSONA)).toEqual({ userId: "dr-reyes", role: "physician" });
  });

  it("labels a persona for the header", () => {
    expect(personaLabel(DEFAULT_PERSONA)).toBe("Dr. Alicia Reyes · Internal Medicine");
  });
});
