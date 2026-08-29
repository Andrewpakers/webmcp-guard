import { faker } from "@faker-js/faker";
import type BetterSqlite3 from "better-sqlite3";

import { applySchema, isDatabaseEmpty } from "./schema";
import type { Appointment, AppointmentStatus, Patient, VisitNote } from "./types";

/**
 * Deterministic demo dataset for Lakeside Medical.
 *
 * Everything here is fabricated on purpose and is safe to publish:
 *  - names/addresses come from faker, so they belong to nobody;
 *  - SSNs use the 900-series, which the SSA has never issued and never will;
 *  - phone numbers use the 555-01xx block reserved for fiction;
 *  - e-mail uses the reserved `example.com` domain.
 *
 * The generator is committed instead of a data dump (docs/05) and is seeded with
 * a fixed value, so the same MRN always belongs to the same person — the demo
 * script, the screenshots and the Phase 3 tokenization tests all depend on that.
 *
 * The only clock-dependent part is *when* notes and appointments happen: those
 * are placed relative to `now` (with offsets derived from the record's index,
 * never at random) so that a freshly booted demo always has "this week" data.
 */

/** Fixed faker seed. Changing it reshuffles every patient in the demo. */
export const FAKER_SEED = 20260903;

/** How many patients the demo ships with (docs/05: ~60). */
export const SEED_PATIENT_COUNT = 60;

/** First MRN issued; patient `i` gets `LM-${MRN_START + i}`. */
const MRN_START = 100001;

/**
 * Fixed reference date for birth dates and record-creation dates, so those
 * columns do not drift with the wall clock and the seed stays comparable.
 */
const REFERENCE_DATE = new Date("2026-01-01T00:00:00.000Z");

const CONDITIONS = [
  "Hypertension",
  "Type 2 diabetes",
  "Asthma",
  "Hyperlipidemia",
  "Osteoarthritis",
  "Atrial fibrillation",
  "Chronic kidney disease stage 2",
  "Hypothyroidism",
  "GERD",
  "Migraine",
  "Anemia",
  "Seasonal allergic rhinitis",
];

const MEDICATIONS = [
  "Lisinopril 10 mg daily",
  "Metformin 500 mg twice daily",
  "Atorvastatin 20 mg nightly",
  "Albuterol inhaler as needed",
  "Levothyroxine 75 mcg daily",
  "Amlodipine 5 mg daily",
  "Omeprazole 20 mg daily",
  "Hydrochlorothiazide 25 mg daily",
  "Sertraline 50 mg daily",
  "Apixaban 5 mg twice daily",
];

const ALLERGIES = [
  "Penicillin",
  "Sulfa drugs",
  "Latex",
  "Shellfish",
  "Peanuts",
  "Contrast dye",
  "Codeine",
];

const INSURANCE_CARRIERS = [
  "Northwater Health",
  "Cascadia Mutual",
  "Vermillion Health Plan",
  "BlueRidge Assurance",
  "Harborline Benefits",
  "Meridian Care Network",
];

/** The three personas docs/05 uses for the Phase 6 mock login, reused as staff. */
const CLINICIANS = [
  "Dr. Alicia Reyes",
  "Dr. Marcus Tan",
  "Dr. Priya Raman",
  "NP Dana Okafor",
  "Dr. Elliot Frank",
];

const VISIT_REASONS = [
  "annual wellness visit",
  "hypertension follow-up",
  "medication reconciliation",
  "post-operative check",
  "diabetes management",
  "lab results review",
  "acute upper respiratory infection",
  "physical therapy referral",
];

const APPOINTMENT_REASONS = [
  "Hypertension follow-up",
  "Annual physical",
  "Lab draw",
  "Medication review",
  "Cardiology consult",
  "Diabetic foot exam",
  "Immunization",
  "Post-op wound check",
];

/** Area codes used for the fictional 555-01xx phone block. */
const AREA_CODES = ["206", "312", "415", "503", "617", "718", "812", "919"];

export interface SeedData {
  patients: Patient[];
  notes: VisitNote[];
  appointments: Appointment[];
}

export interface SeedOptions {
  /** Clock used to place notes in the past and appointments in the future. */
  now?: Date;
  /** Patient count override (tests use small values). */
  patientCount?: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

/** Human-readable date for note prose, e.g. "March 4, 2026". */
function longDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * How many appointments patient `i` gets, and how far out each one sits.
 * Purely index-derived so a boot always produces the same shape (docs/05 wants
 * a healthy "this week" bucket for the demo script's first question).
 */
export function appointmentCountFor(index: number): number {
  return index % 4; // 0, 1, 2, 3 — 45 of 60 patients have at least one.
}

export function appointmentDayOffset(index: number, slot: number): number {
  // Slot 0 lands inside the next week for two thirds of the patients that have
  // any appointment at all (30 of 60), comfortably above the "at least 15" bar.
  if (slot === 0 && index % 3 !== 0) {
    return 1 + ((index + slot) % 7);
  }
  return 8 + ((index * 3 + slot * 11) % 50);
}

/**
 * Builds the whole demo dataset in memory. Pure apart from `now`: calling it
 * twice with the same clock returns deeply equal data.
 */
export function generateSeedData(options: SeedOptions = {}): SeedData {
  const now = options.now ?? new Date();
  const patientCount = options.patientCount ?? SEED_PATIENT_COUNT;

  faker.seed(FAKER_SEED);

  const patients: Patient[] = [];

  for (let i = 0; i < patientCount; i += 1) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const dob = isoDate(
      faker.date.birthdate({ mode: "age", min: 19, max: 91, refDate: REFERENCE_DATE }),
    );

    // 900-series SSNs were never issued by the SSA: unmistakably synthetic, but
    // still shaped exactly like the real thing so the classifier has real work.
    const ssnArea = 900 + (i % 100);
    const ssnGroup = String(faker.number.int({ min: 1, max: 99 })).padStart(2, "0");
    const ssnSerial = String(faker.number.int({ min: 1, max: 9999 })).padStart(4, "0");

    // 555-0100..555-0199 is the block reserved for fictional US phone numbers.
    const areaCode = faker.helpers.arrayElement(AREA_CODES);
    const phoneLine = String(100 + (i % 100)).padStart(4, "0");

    // Every third patient is hypertensive: the demo script opens by asking for
    // exactly that cohort, so it must never come back empty.
    const extraConditions = faker.helpers.arrayElements(
      CONDITIONS.filter((c) => c !== "Hypertension"),
      { min: 1, max: 2 },
    );
    const primaryConditions = i % 3 === 0 ? ["Hypertension", ...extraConditions] : extraConditions;

    patients.push({
      id: faker.string.uuid(),
      mrn: `LM-${MRN_START + i}`,
      firstName,
      lastName,
      dob,
      ssn: `${ssnArea}-${ssnGroup}-${ssnSerial}`,
      phone: `(${areaCode}) 555-${phoneLine}`,
      email: `${firstName}.${lastName}${i}@example.com`.toLowerCase(),
      addressStreet: faker.location.streetAddress(),
      addressCity: faker.location.city(),
      addressState: faker.location.state({ abbreviated: true }),
      addressZip: faker.location.zipCode("#####"),
      insuranceCarrier: faker.helpers.arrayElement(INSURANCE_CARRIERS),
      insuranceMemberId: `${faker.string.alpha({ length: 3, casing: "upper" })}${faker.string.numeric(9)}`,
      primaryConditions,
      medications: faker.helpers.arrayElements(MEDICATIONS, { min: 1, max: 3 }),
      allergies: faker.helpers.arrayElements(ALLERGIES, { min: 0, max: 2 }),
      createdAt: addDays(REFERENCE_DATE, -(30 + i * 11)).toISOString(),
    });
  }

  const notes: VisitNote[] = [];
  const appointments: Appointment[] = [];

  for (let i = 0; i < patients.length; i += 1) {
    const patient = patients[i];
    const fullName = `${patient.firstName} ${patient.lastName}`;
    const noteCount = 2 + (i % 5); // 2..6, per docs/05.

    for (let n = 0; n < noteCount; n += 1) {
      const authoredAt = addDays(now, -(9 + n * 47 + (i % 13)));
      const author = faker.helpers.arrayElement(CLINICIANS);
      const reason = faker.helpers.arrayElement(VISIT_REASONS);
      const systolic = faker.number.int({ min: 108, max: 168 });
      const diastolic = faker.number.int({ min: 62, max: 98 });
      const medication = patient.medications[0] ?? "no active prescriptions";

      // Notes deliberately restate PHI in prose. The free-text scanner built in
      // Phase 3 needs names, phone numbers and DOBs sitting inside sentences,
      // not just in structured columns.
      const lines = [
        `${longDate(authoredAt)} — ${fullName} (DOB ${patient.dob}, MRN ${patient.mrn}) seen today for ${reason}.`,
        `Blood pressure ${systolic}/${diastolic}. Continuing ${medication}.`,
        `Reached ${patient.firstName} by phone at ${patient.phone} to confirm the plan; mailing address on file is ${patient.addressStreet}, ${patient.addressCity}, ${patient.addressState} ${patient.addressZip}.`,
      ];

      // Roughly a third of notes name a *different* seeded patient. Cross-record
      // references are what make the Phase 3 dictionary scan worth building.
      if (n % 3 === 1 && patients.length > 1) {
        const other = patients[(i + 7 + n) % patients.length];
        if (other.id !== patient.id) {
          lines.push(
            `Emergency contact ${other.firstName} ${other.lastName} was reached at ${other.phone} and is aware of the follow-up schedule.`,
          );
        }
      }

      lines.push(
        `Insurance verified with ${patient.insuranceCarrier} (member ${patient.insuranceMemberId}). ${author} to review in ${2 + (n % 4)} weeks.`,
      );

      notes.push({
        id: faker.string.uuid(),
        patientId: patient.id,
        authoredAt: authoredAt.toISOString(),
        author,
        body: lines.join(" "),
      });
    }

    const apptCount = appointmentCountFor(i);
    for (let slot = 0; slot < apptCount; slot += 1) {
      const scheduled = addDays(now, appointmentDayOffset(i, slot));
      scheduled.setUTCHours(15 + ((i + slot) % 5), ((i + slot) % 4) * 15, 0, 0);
      const status: AppointmentStatus =
        slot === 0 && i % 5 === 0 ? "confirmed" : slot === 2 ? "checked-in" : "scheduled";

      appointments.push({
        id: faker.string.uuid(),
        patientId: patient.id,
        scheduledAt: scheduled.toISOString(),
        reason: faker.helpers.arrayElement(APPOINTMENT_REASONS),
        provider: faker.helpers.arrayElement(CLINICIANS),
        status,
      });
    }
  }

  return { patients, notes, appointments };
}

/** Writes a generated dataset into an (already schema'd) database in one transaction. */
export function insertSeedData(db: BetterSqlite3.Database, data: SeedData): void {
  const insertPatient = db.prepare(`
    INSERT INTO patients (
      id, mrn, first_name, last_name, dob, ssn, phone, email,
      address_street, address_city, address_state, address_zip,
      insurance_carrier, insurance_member_id,
      primary_conditions, medications, allergies, created_at
    ) VALUES (
      @id, @mrn, @firstName, @lastName, @dob, @ssn, @phone, @email,
      @addressStreet, @addressCity, @addressState, @addressZip,
      @insuranceCarrier, @insuranceMemberId,
      @primaryConditions, @medications, @allergies, @createdAt
    )
  `);
  const insertNote = db.prepare(`
    INSERT INTO visit_notes (id, patient_id, authored_at, author, body)
    VALUES (@id, @patientId, @authoredAt, @author, @body)
  `);
  const insertAppointment = db.prepare(`
    INSERT INTO appointments (id, patient_id, scheduled_at, reason, provider, status)
    VALUES (@id, @patientId, @scheduledAt, @reason, @provider, @status)
  `);

  const run = db.transaction((seed: SeedData) => {
    for (const patient of seed.patients) {
      insertPatient.run({
        ...patient,
        primaryConditions: JSON.stringify(patient.primaryConditions),
        medications: JSON.stringify(patient.medications),
        allergies: JSON.stringify(patient.allergies),
      });
    }
    for (const note of seed.notes) insertNote.run(note);
    for (const appointment of seed.appointments) insertAppointment.run(appointment);
  });

  run(data);
}

/**
 * Idempotent seed-on-boot (docs/03): create the schema if it is missing, then
 * populate it only when there are no patients. Safe to call on every request.
 *
 * @returns `true` when this call actually wrote the demo data.
 */
export function seedIfEmpty(db: BetterSqlite3.Database, options: SeedOptions = {}): boolean {
  applySchema(db);
  if (!isDatabaseEmpty(db)) return false;
  insertSeedData(db, generateSeedData(options));
  return true;
}
