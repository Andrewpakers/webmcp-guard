import { describe, expect, it } from "vitest";

import {
  SEED_PATIENT_COUNT,
  appointmentCountFor,
  appointmentDayOffset,
  generateSeedData,
} from "./seed";

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("generateSeedData — shape", () => {
  const data = generateSeedData({ now: NOW });

  it("produces exactly the documented patient count", () => {
    expect(data.patients).toHaveLength(SEED_PATIENT_COUNT);
  });

  it("issues sequential, unique LM-###### medical record numbers", () => {
    expect(data.patients[0].mrn).toBe("LM-100001");
    expect(data.patients.at(-1)?.mrn).toBe("LM-100060");
    expect(new Set(data.patients.map((p) => p.mrn)).size).toBe(SEED_PATIENT_COUNT);
  });

  it("only issues SSNs from the 900-series the SSA never allocated", () => {
    for (const patient of data.patients) {
      expect(patient.ssn).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    }
  });

  it("uses the reserved 555-01xx fictional phone block and example.com e-mail", () => {
    for (const patient of data.patients) {
      expect(patient.phone).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
      expect(patient.email.endsWith("@example.com")).toBe(true);
    }
  });

  it("gives many patients hypertension so the demo script's first query lands", () => {
    const hypertensive = data.patients.filter((p) =>
      p.primaryConditions.some((c) => c.toLowerCase().includes("hypertension")),
    );
    expect(hypertensive.length).toBeGreaterThanOrEqual(15);
  });

  it("writes 2-6 visit notes per patient", () => {
    for (const patient of data.patients) {
      const count = data.notes.filter((n) => n.patientId === patient.id).length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it("gives every patient 0-3 appointments, all in the future", () => {
    for (const patient of data.patients) {
      const appts = data.appointments.filter((a) => a.patientId === patient.id);
      expect(appts.length).toBeGreaterThanOrEqual(0);
      expect(appts.length).toBeLessThanOrEqual(3);
      for (const appt of appts) {
        expect(new Date(appt.scheduledAt).getTime()).toBeGreaterThan(NOW.getTime());
      }
    }
  });

  it("puts at least 15 patients on the schedule within the next 7 days", () => {
    const horizon = NOW.getTime() + 7 * 86_400_000;
    const soon = new Set(
      data.appointments
        .filter((a) => new Date(a.scheduledAt).getTime() <= horizon)
        .map((a) => a.patientId),
    );
    expect(soon.size).toBeGreaterThanOrEqual(15);
  });
});

describe("generateSeedData — embedded PHI in free text", () => {
  const data = generateSeedData({ now: NOW });

  it("restates the patient's own name, phone and DOB inside note prose", () => {
    for (const patient of data.patients) {
      const notes = data.notes.filter((n) => n.patientId === patient.id);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(note.body).toContain(`${patient.firstName} ${patient.lastName}`);
        expect(note.body).toContain(patient.phone);
        expect(note.body).toContain(patient.dob);
        expect(note.body).toContain(patient.mrn);
      }
    }
  });

  it("cross-references other seeded patients by name (dictionary-scan fodder)", () => {
    const namesByPatient = new Map(
      data.patients.map((p) => [p.id, `${p.firstName} ${p.lastName}`]),
    );

    const crossReferencing = data.notes.filter((note) => {
      const ownName = namesByPatient.get(note.patientId);
      return data.patients.some(
        (other) =>
          other.id !== note.patientId &&
          `${other.firstName} ${other.lastName}` !== ownName &&
          note.body.includes(`${other.firstName} ${other.lastName}`),
      );
    });

    expect(crossReferencing.length).toBeGreaterThanOrEqual(30);
  });
});

describe("generateSeedData — determinism", () => {
  it("returns identical data for the same clock", () => {
    const a = generateSeedData({ now: NOW });
    const b = generateSeedData({ now: NOW });

    expect(b.patients[0]).toEqual(a.patients[0]);
    expect(b.patients.at(-1)).toEqual(a.patients.at(-1));
    expect(b.notes).toEqual(a.notes);
    expect(b.appointments).toEqual(a.appointments);
  });

  it("keeps patient records stable even when the clock moves", () => {
    const a = generateSeedData({ now: NOW });
    const b = generateSeedData({ now: new Date("2027-02-14T08:30:00.000Z") });

    // Demographics are pinned to a fixed reference date...
    expect(b.patients).toEqual(a.patients);
    // ...but the schedule follows the clock so the demo always has fresh data.
    expect(b.appointments[0].scheduledAt).not.toBe(a.appointments[0].scheduledAt);
  });
});

describe("appointment placement helpers", () => {
  it("cycles 0-3 appointments per patient", () => {
    expect([0, 1, 2, 3, 4, 5].map(appointmentCountFor)).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it("keeps every offset in the future and slot 0 inside the week for most", () => {
    let withinWeek = 0;
    for (let i = 0; i < SEED_PATIENT_COUNT; i += 1) {
      for (let slot = 0; slot < appointmentCountFor(i); slot += 1) {
        const offset = appointmentDayOffset(i, slot);
        expect(offset).toBeGreaterThanOrEqual(1);
        if (slot === 0 && offset <= 7) withinWeek += 1;
      }
    }
    expect(withinWeek).toBeGreaterThanOrEqual(15);
  });
});
