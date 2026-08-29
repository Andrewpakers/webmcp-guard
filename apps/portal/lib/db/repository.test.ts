import type BetterSqlite3 from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CSV_COLUMNS,
  addVisitNote,
  countPatients,
  deletePatient,
  exportPatientsCsv,
  getPatient,
  listAppointments,
  patientNotFoundMessage,
  searchPatients,
  updatePatient,
} from "./repository";
import { SEED_PATIENT_COUNT } from "./seed";
import { createTestDb } from "./testing";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db?.close();
  db = createTestDb();
});

afterAll(() => {
  db?.close();
});

describe("searchPatients", () => {
  it("returns every seeded patient when unfiltered", () => {
    expect(searchPatients({ limit: 500 }, db)).toHaveLength(SEED_PATIENT_COUNT);
  });

  it("sorts by last name then first name", () => {
    const rows = searchPatients({ limit: 500 }, db);
    const keys = rows.map((r) => `${r.lastName} ${r.firstName}`.toLowerCase());
    expect(keys).toEqual([...keys].sort());
  });

  it("matches free text against the MRN", () => {
    const rows = searchPatients({ text: "LM-100001" }, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].mrn).toBe("LM-100001");
  });

  it("matches free text case-insensitively against the full name", () => {
    const target = searchPatients({ text: "LM-100007" }, db)[0];
    const fullName = `${target.firstName} ${target.lastName}`;

    const byUpper = searchPatients({ text: fullName.toUpperCase() }, db);
    expect(byUpper.map((r) => r.mrn)).toContain(target.mrn);

    const byLastNameFragment = searchPatients(
      { text: target.lastName.slice(0, 3).toLowerCase() },
      db,
    );
    expect(byLastNameFragment.map((r) => r.mrn)).toContain(target.mrn);
  });

  it("finds the hypertension cohort the demo script opens with", () => {
    const rows = searchPatients({ condition: "hypertension", limit: 500 }, db);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.primaryConditions.join(" ").toLowerCase()).toContain("hypertension");
    }
  });

  it("ANDs text and condition filters", () => {
    const hypertensive = searchPatients({ condition: "Hypertension", limit: 500 }, db);
    const one = hypertensive[0];
    const both = searchPatients({ text: one.mrn, condition: "hypertension" }, db);
    expect(both).toHaveLength(1);
    expect(both[0].mrn).toBe(one.mrn);

    expect(searchPatients({ text: one.mrn, condition: "no-such-condition" }, db)).toHaveLength(0);
  });

  it("returns an empty list rather than throwing on a miss", () => {
    expect(searchPatients({ text: "zzzz-not-a-patient" }, db)).toEqual([]);
  });

  it("honours the limit, clamped to a sane range", () => {
    expect(searchPatients({ limit: 5 }, db)).toHaveLength(5);
    expect(searchPatients({ limit: 0 }, db)).toHaveLength(1);
    expect(searchPatients({ limit: 10_000 }, db)).toHaveLength(SEED_PATIENT_COUNT);
  });

  it("surfaces the soonest future appointment for each patient", () => {
    const rows = searchPatients({ limit: 500 }, db);
    const withAppointment = rows.filter((r) => r.nextAppointmentAt !== null);
    expect(withAppointment.length).toBeGreaterThan(0);

    for (const row of withAppointment) {
      const detail = getPatient(row.id, db);
      const soonest = detail?.appointments
        .map((a) => a.scheduledAt)
        .sort()
        .at(0);
      expect(row.nextAppointmentAt).toBe(soonest);
    }
  });
});

describe("countPatients", () => {
  it("counts the whole table and a filtered slice", () => {
    expect(countPatients({}, db)).toBe(SEED_PATIENT_COUNT);
    const hypertensive = countPatients({ condition: "hypertension" }, db);
    expect(hypertensive).toBeGreaterThanOrEqual(15);
    expect(hypertensive).toBeLessThan(SEED_PATIENT_COUNT);
  });
});

describe("getPatient", () => {
  it("looks a patient up by MRN", () => {
    const patient = getPatient("LM-100001", db);
    expect(patient?.mrn).toBe("LM-100001");
  });

  it("looks the same patient up by primary key", () => {
    const byMrn = getPatient("LM-100001", db);
    expect(byMrn).not.toBeNull();
    expect(getPatient(byMrn?.id ?? "", db)?.mrn).toBe("LM-100001");
  });

  it("returns notes newest-first and appointments soonest-first", () => {
    const patient = getPatient("LM-100004", db);
    const noteDates = patient?.notes.map((n) => n.authoredAt) ?? [];
    expect(noteDates).toEqual([...noteDates].sort().reverse());

    const apptDates = patient?.appointments.map((a) => a.scheduledAt) ?? [];
    expect(apptDates).toEqual([...apptDates].sort());
  });

  it("returns raw, unmasked PHI — this is the Phase 1 'before' picture", () => {
    const patient = getPatient("LM-100001", db);
    expect(patient?.ssn).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
  });

  it("returns null for an unknown identifier", () => {
    expect(getPatient("LM-999999", db)).toBeNull();
    expect(getPatient("", db)).toBeNull();
  });

  /**
   * Phase 3: a `tok_name_…` the agent carried back from a search result is
   * resolved to a full name before the tool runs, so a full name has to work as
   * an identifier — but only when it is unambiguous.
   */
  describe("full-name lookup", () => {
    const target = () => getPatient("LM-100001", db);

    it("looks a patient up by their exact full name", () => {
      const patient = target();
      const name = `${patient?.firstName} ${patient?.lastName}`;
      expect(getPatient(name, db)?.mrn).toBe("LM-100001");
    });

    it("is case-insensitive and tolerates sloppy whitespace", () => {
      const patient = target();
      expect(getPatient(`${patient?.firstName} ${patient?.lastName}`.toUpperCase(), db)?.mrn).toBe(
        "LM-100001",
      );
      expect(getPatient(`  ${patient?.firstName}   ${patient?.lastName}  `, db)?.mrn).toBe(
        "LM-100001",
      );
    });

    it("refuses a partial name", () => {
      expect(getPatient(target()?.lastName ?? "", db)).toBeNull();
      expect(getPatient(target()?.firstName ?? "", db)).toBeNull();
    });

    it("refuses an ambiguous name rather than guessing which patient was meant", () => {
      const patient = target();
      const name = `${patient?.firstName} ${patient?.lastName}`;
      // A second patient with the same name: putting a note on the wrong chart
      // is worse than failing the call.
      db.prepare(
        "UPDATE patients SET first_name = @first, last_name = @last WHERE mrn = 'LM-100002'",
      ).run({ first: patient?.firstName, last: patient?.lastName });

      expect(getPatient(name, db)).toBeNull();
      // The unambiguous identifiers still work.
      expect(getPatient("LM-100001", db)?.mrn).toBe("LM-100001");
      expect(getPatient("LM-100002", db)?.mrn).toBe("LM-100002");
    });

    it("prefers an id or MRN over a name that happens to collide with one", () => {
      db.prepare(
        "UPDATE patients SET first_name = 'LM-100001', last_name = 'X' WHERE mrn = 'LM-100003'",
      ).run();
      expect(getPatient("LM-100001", db)?.mrn).toBe("LM-100001");
    });
  });
});

describe("patientNotFoundMessage", () => {
  it("names every identifier that would have worked", () => {
    const message = patientNotFoundMessage("Nobody Here");
    expect(message).toContain("Nobody Here");
    expect(message).toContain("MRN");
    expect(message).toContain("full name");
    expect(message).toContain("exactly one patient");
  });
});

describe("updatePatient", () => {
  it("writes only the supplied fields", () => {
    const before = getPatient("LM-100002", db);
    const after = updatePatient("LM-100002", { phone: "(206) 555-0199" }, db);

    expect(after?.phone).toBe("(206) 555-0199");
    expect(after?.firstName).toBe(before?.firstName);
    expect(after?.email).toBe(before?.email);
  });

  it("accepts an id as well as an MRN", () => {
    const patient = getPatient("LM-100003", db);
    const after = updatePatient(patient?.id ?? "", { addressCity: "Lakeside" }, db);
    expect(after?.addressCity).toBe("Lakeside");
  });

  it("ignores keys outside the update allowlist", () => {
    const before = getPatient("LM-100005", db);
    const after = updatePatient(
      "LM-100005",
      { mrn: "LM-000000", ssn: "111-22-3333", firstName: "Renamed" } as never,
      db,
    );

    expect(after?.firstName).toBe("Renamed");
    expect(after?.mrn).toBe("LM-100005");
    expect(after?.ssn).toBe(before?.ssn);
  });

  it("is a no-op that still returns the record when nothing is supplied", () => {
    const before = getPatient("LM-100006", db);
    expect(updatePatient("LM-100006", {}, db)).toEqual(before);
  });

  it("returns null for an unknown patient", () => {
    expect(updatePatient("LM-999999", { phone: "x" }, db)).toBeNull();
  });
});

describe("addVisitNote", () => {
  it("appends a note that shows up first in the timeline", () => {
    const note = addVisitNote("LM-100001", "Called about refill.", "Dr. Alicia Reyes", db);
    expect(note?.body).toBe("Called about refill.");

    const patient = getPatient("LM-100001", db);
    expect(patient?.notes[0].id).toBe(note?.id);
    expect(patient?.notes[0].author).toBe("Dr. Alicia Reyes");
  });

  it("falls back to a default author", () => {
    const note = addVisitNote("LM-100002", "Left voicemail.", "   ", db);
    expect(note?.author).toBe("Portal user");
  });

  it("returns null for an unknown patient", () => {
    expect(addVisitNote("LM-999999", "orphan note", "someone", db)).toBeNull();
  });
});

describe("listAppointments", () => {
  it("returns upcoming appointments soonest-first with patient identity attached", () => {
    const appts = listAppointments({}, db);
    expect(appts.length).toBeGreaterThan(0);

    const times = appts.map((a) => a.scheduledAt);
    expect(times).toEqual([...times].sort());

    for (const appt of appts) {
      expect(appt.patientMrn).toMatch(/^LM-\d{6}$/);
      expect(appt.patientName.length).toBeGreaterThan(2);
      expect(new Date(appt.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("narrows to a horizon", () => {
    const week = listAppointments({ withinDays: 7 }, db);
    const all = listAppointments({}, db);
    expect(week.length).toBeGreaterThan(0);
    expect(week.length).toBeLessThan(all.length);

    const horizon = Date.now() + 7 * 86_400_000;
    for (const appt of week) {
      expect(new Date(appt.scheduledAt).getTime()).toBeLessThanOrEqual(horizon);
    }
    // docs/05: the demo asks "who has an appointment this week".
    expect(new Set(week.map((a) => a.patientId)).size).toBeGreaterThanOrEqual(15);
  });

  it("narrows to one patient, by id or MRN", () => {
    const anyAppt = listAppointments({}, db)[0];
    const byId = listAppointments({ patientId: anyAppt.patientId }, db);
    const byMrn = listAppointments({ patientId: anyAppt.patientMrn }, db);

    expect(byId.length).toBeGreaterThan(0);
    expect(byMrn).toEqual(byId);
    for (const appt of byId) expect(appt.patientId).toBe(anyAppt.patientId);
  });
});

describe("exportPatientsCsv", () => {
  it("emits a header plus one row per matching patient", () => {
    const csv = exportPatientsCsv({ limit: 500 }, db);
    const lines = csv.trimEnd().split("\r\n");

    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(SEED_PATIENT_COUNT + 1);
  });

  it("respects the same filters as the search box", () => {
    const csv = exportPatientsCsv({ condition: "hypertension", limit: 500 }, db);
    const rows = csv.trimEnd().split("\r\n").slice(1);
    expect(rows.length).toBe(countPatients({ condition: "hypertension" }, db));
    for (const row of rows) expect(row.toLowerCase()).toContain("hypertension");
  });

  it("quotes fields containing the delimiter instead of splitting the row", () => {
    updatePatient("LM-100001", { addressStreet: '4 "Old" Mill Rd, Unit 2' }, db);
    const csv = exportPatientsCsv({ text: "LM-100001" }, db);
    const row = csv.trimEnd().split("\r\n")[1];

    expect(row).toContain('"4 ""Old"" Mill Rd, Unit 2,');
  });

  it("exports raw SSNs — deliberately, as the unguarded baseline", () => {
    const csv = exportPatientsCsv({ text: "LM-100001", limit: 1 }, db);
    expect(csv).toMatch(/9\d{2}-\d{2}-\d{4}/);
  });
});

describe("deletePatient", () => {
  it("removes the patient and cascades to notes and appointments", () => {
    const patient = getPatient("LM-100003", db);
    expect(patient?.notes.length).toBeGreaterThan(0);

    const deleted = deletePatient("LM-100003", db);
    expect(deleted?.mrn).toBe("LM-100003");
    expect(getPatient("LM-100003", db)).toBeNull();

    const noteCount = db
      .prepare("SELECT COUNT(*) AS c FROM visit_notes WHERE patient_id = ?")
      .get(patient?.id) as { c: number };
    const apptCount = db
      .prepare("SELECT COUNT(*) AS c FROM appointments WHERE patient_id = ?")
      .get(patient?.id) as { c: number };

    expect(noteCount.c).toBe(0);
    expect(apptCount.c).toBe(0);
    expect(countPatients({}, db)).toBe(SEED_PATIENT_COUNT - 1);
  });

  it("returns null for an unknown patient", () => {
    expect(deletePatient("LM-999999", db)).toBeNull();
  });
});
