import { randomUUID } from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { getDb } from "./connection";
import { toCsv } from "./csv";
import type {
  Appointment,
  AppointmentQuery,
  AppointmentWithPatient,
  Patient,
  PatientDetail,
  PatientQuery,
  PatientSummary,
  PatientUpdate,
  VisitNote,
} from "./types";

/**
 * Typed data access for the host application's patient tables.
 *
 * Server-only (it reaches SQLite). Every function takes the database as an
 * optional trailing argument so tests can drive an in-memory instance; at
 * runtime the default is the memoised connection from `./connection`.
 *
 * Nothing here knows about WebMCP or WebMCP Guard: this is the app's own data
 * layer, and in Phase 1 it hands back raw records — SSNs included. That is the
 * "before" picture the guard SDK is introduced to fix in Phase 2/3.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface PatientRow {
  id: string;
  mrn: string;
  first_name: string;
  last_name: string;
  dob: string;
  ssn: string;
  phone: string;
  email: string;
  address_street: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  insurance_carrier: string;
  insurance_member_id: string;
  primary_conditions: string;
  medications: string;
  allergies: string;
  created_at: string;
}

interface NoteRow {
  id: string;
  patient_id: string;
  authored_at: string;
  author: string;
  body: string;
}

interface AppointmentRow {
  id: string;
  patient_id: string;
  scheduled_at: string;
  reason: string;
  provider: string;
  status: string;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    mrn: row.mrn,
    firstName: row.first_name,
    lastName: row.last_name,
    dob: row.dob,
    ssn: row.ssn,
    phone: row.phone,
    email: row.email,
    addressStreet: row.address_street,
    addressCity: row.address_city,
    addressState: row.address_state,
    addressZip: row.address_zip,
    insuranceCarrier: row.insurance_carrier,
    insuranceMemberId: row.insurance_member_id,
    primaryConditions: parseJsonArray(row.primary_conditions),
    medications: parseJsonArray(row.medications),
    allergies: parseJsonArray(row.allergies),
    createdAt: row.created_at,
  };
}

function toNote(row: NoteRow): VisitNote {
  return {
    id: row.id,
    patientId: row.patient_id,
    authoredAt: row.authored_at,
    author: row.author,
    body: row.body,
  };
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    patientId: row.patient_id,
    scheduledAt: row.scheduled_at,
    reason: row.reason,
    provider: row.provider,
    status: row.status as Appointment["status"],
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * Shared WHERE builder for search and export so the CSV always contains exactly
 * the rows the caller just looked at.
 *
 * `text` matches first/last name, the full name, MRN, e-mail and phone;
 * `condition` matches the JSON-encoded `primary_conditions`. Both are
 * case-insensitive substring matches, which is what a clinician expects from a
 * patient-lookup box (and what the agent gets from `search_patients`).
 */
function buildPatientFilter(query: PatientQuery): { sql: string; params: Record<string, string> } {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  const text = query.text?.trim();
  if (text) {
    params.text = `%${text.toLowerCase()}%`;
    clauses.push(
      `(LOWER(first_name) LIKE @text
        OR LOWER(last_name) LIKE @text
        OR LOWER(first_name || ' ' || last_name) LIKE @text
        OR LOWER(mrn) LIKE @text
        OR LOWER(email) LIKE @text
        OR LOWER(phone) LIKE @text)`,
    );
  }

  const condition = query.condition?.trim();
  if (condition) {
    params.condition = `%${condition.toLowerCase()}%`;
    clauses.push("LOWER(primary_conditions) LIKE @condition");
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Patient list / agent search. Returns lightweight summaries (no SSN, no
 * insurance) plus the soonest future appointment, which the list view shows as
 * "Next appointment" and the demo script asks about.
 */
export function searchPatients(
  query: PatientQuery = {},
  db: BetterSqlite3.Database = getDb(),
): PatientSummary[] {
  const { sql: where, params } = buildPatientFilter(query);
  const rows = db
    .prepare(
      `SELECT p.id, p.mrn, p.first_name, p.last_name, p.dob, p.phone, p.primary_conditions,
              (SELECT MIN(a.scheduled_at) FROM appointments a
                WHERE a.patient_id = p.id AND a.scheduled_at >= @now) AS next_appointment_at
         FROM patients p
         ${where}
        ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE
        LIMIT @limit`,
    )
    .all({ ...params, now: new Date().toISOString(), limit: clampLimit(query.limit) }) as Array<
    Pick<
      PatientRow,
      "id" | "mrn" | "first_name" | "last_name" | "dob" | "phone" | "primary_conditions"
    > & { next_appointment_at: string | null }
  >;

  return rows.map((row) => ({
    id: row.id,
    mrn: row.mrn,
    firstName: row.first_name,
    lastName: row.last_name,
    dob: row.dob,
    phone: row.phone,
    primaryConditions: parseJsonArray(row.primary_conditions),
    nextAppointmentAt: row.next_appointment_at,
  }));
}

/** Total patients matching a filter — used by the export page's live count. */
export function countPatients(
  query: PatientQuery = {},
  db: BetterSqlite3.Database = getDb(),
): number {
  const { sql: where, params } = buildPatientFilter(query);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM patients ${where}`).get(params) as {
    count: number;
  };
  return row.count;
}

/**
 * The one sentence every lookup failure answers with. It exists as a function
 * so all four write routes say the same thing, and because an agent reads it:
 * it has to name every identifier that *would* have worked.
 */
export function patientNotFoundMessage(key: string): string {
  return (
    `No patient found for '${key}'. Identify a patient by their MRN (e.g. 'LM-100042'), ` +
    `by their internal id, or by their full name exactly as it is on file ` +
    `(e.g. 'Tricia Bashirian') — a name is only accepted when it matches exactly one patient, ` +
    `so use search_patients first if it might be ambiguous.`
  );
}

/**
 * Resolves the several things a caller might hand us for "which patient":
 * internal id, MRN, or — since Phase 3 — a full name.
 *
 * The name branch exists because of detokenization: a `tok_name_…` the agent
 * carried back from a search result becomes "Tricia Bashirian" before the tool
 * runs, and that string has to be usable as an identifier. It resolves **only
 * when exactly one patient matches**; two Ada Byrons are an ambiguous request,
 * and quietly picking one of them is the sort of thing that puts a note on the
 * wrong chart.
 */
function findPatientRow(idOrMrn: string, db: BetterSqlite3.Database): PatientRow | undefined {
  const key = idOrMrn.trim().replace(/\s+/g, " ");
  if (key.length === 0) return undefined;

  const direct = db
    .prepare("SELECT * FROM patients WHERE id = @key OR mrn = @key COLLATE NOCASE LIMIT 1")
    .get({ key }) as PatientRow | undefined;
  if (direct) return direct;

  const byName = db
    .prepare(
      `SELECT * FROM patients
        WHERE LOWER(first_name || ' ' || last_name) = LOWER(@key)
        LIMIT 2`,
    )
    .all({ key }) as PatientRow[];

  return byName.length === 1 ? byName[0] : undefined;
}

/** Looks a patient up by primary key, MRN or unambiguous full name. */
export function getPatient(
  idOrMrn: string,
  db: BetterSqlite3.Database = getDb(),
): PatientDetail | null {
  const row = findPatientRow(idOrMrn, db);
  if (!row) return null;

  const notes = db
    .prepare("SELECT * FROM visit_notes WHERE patient_id = ? ORDER BY authored_at DESC")
    .all(row.id) as NoteRow[];
  const appointments = db
    .prepare("SELECT * FROM appointments WHERE patient_id = ? ORDER BY scheduled_at ASC")
    .all(row.id) as AppointmentRow[];

  return {
    ...toPatient(row),
    notes: notes.map(toNote),
    appointments: appointments.map(toAppointment),
  };
}

const UPDATABLE_COLUMNS: Record<keyof PatientUpdate, string> = {
  firstName: "first_name",
  lastName: "last_name",
  phone: "phone",
  email: "email",
  addressStreet: "address_street",
  addressCity: "address_city",
  addressState: "address_state",
  addressZip: "address_zip",
  insuranceCarrier: "insurance_carrier",
  insuranceMemberId: "insurance_member_id",
};

/**
 * Updates demographics/contact/insurance fields. Unknown keys are ignored rather
 * than rejected — the column allowlist is the write boundary, so an agent (or a
 * confused caller) cannot reach `ssn`, `mrn` or the clinical arrays through here.
 */
export function updatePatient(
  idOrMrn: string,
  fields: PatientUpdate,
  db: BetterSqlite3.Database = getDb(),
): PatientDetail | null {
  const row = findPatientRow(idOrMrn, db);
  if (!row) return null;

  const assignments: string[] = [];
  const params: Record<string, string> = { id: row.id };

  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS) as [
    keyof PatientUpdate,
    string,
  ][]) {
    const value = fields[key];
    if (typeof value === "string") {
      assignments.push(`${column} = @${key}`);
      params[key] = value;
    }
  }

  if (assignments.length > 0) {
    db.prepare(`UPDATE patients SET ${assignments.join(", ")} WHERE id = @id`).run(params);
  }

  return getPatient(row.id, db);
}

/** Appends a visit note. Returns `null` when the patient does not exist. */
export function addVisitNote(
  patientIdOrMrn: string,
  body: string,
  author = "Portal user",
  db: BetterSqlite3.Database = getDb(),
): VisitNote | null {
  const row = findPatientRow(patientIdOrMrn, db);
  if (!row) return null;

  const note: VisitNote = {
    id: randomUUID(),
    patientId: row.id,
    authoredAt: new Date().toISOString(),
    author: author.trim() || "Portal user",
    body: body.trim(),
  };

  db.prepare(
    `INSERT INTO visit_notes (id, patient_id, authored_at, author, body)
     VALUES (@id, @patientId, @authoredAt, @author, @body)`,
  ).run(note);

  return note;
}

/**
 * Upcoming appointments, soonest first, joined with enough patient identity to
 * render a row. Past appointments are never returned — the portal only shows the
 * forward schedule.
 */
export function listAppointments(
  query: AppointmentQuery = {},
  db: BetterSqlite3.Database = getDb(),
): AppointmentWithPatient[] {
  const now = new Date();
  const clauses = ["a.scheduled_at >= @now"];
  const params: Record<string, string | number> = {
    now: now.toISOString(),
    limit: clampLimit(query.limit ?? MAX_LIMIT),
  };

  if (typeof query.withinDays === "number" && Number.isFinite(query.withinDays)) {
    params.until = new Date(now.getTime() + query.withinDays * 86_400_000).toISOString();
    clauses.push("a.scheduled_at <= @until");
  }
  if (query.patientId) {
    params.patientId = query.patientId.trim();
    clauses.push("(a.patient_id = @patientId OR p.mrn = @patientId COLLATE NOCASE)");
  }

  const rows = db
    .prepare(
      `SELECT a.*, p.mrn AS patient_mrn, p.first_name, p.last_name
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.scheduled_at ASC
        LIMIT @limit`,
    )
    .all(params) as Array<
    AppointmentRow & { patient_mrn: string; first_name: string; last_name: string }
  >;

  return rows.map((row) => ({
    ...toAppointment(row),
    patientMrn: row.patient_mrn,
    patientName: `${row.first_name} ${row.last_name}`,
  }));
}

/** Column order of the export. Kept as one list so header and rows cannot drift. */
export const CSV_COLUMNS = [
  "mrn",
  "first_name",
  "last_name",
  "dob",
  "ssn",
  "phone",
  "email",
  "address",
  "insurance_carrier",
  "insurance_member_id",
  "primary_conditions",
  "medications",
  "allergies",
] as const;

/**
 * Bulk export of the current search result.
 *
 * In Phase 1 this emits everything in the clear, SSNs included — that is exactly
 * why docs/05 puts `export_patients` behind `require-justification` once the
 * guard is in place.
 */
export function exportPatientsCsv(
  query: PatientQuery = {},
  db: BetterSqlite3.Database = getDb(),
): string {
  const { sql: where, params } = buildPatientFilter(query);
  const rows = db
    .prepare(
      `SELECT * FROM patients ${where}
        ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
        LIMIT @limit`,
    )
    .all({ ...params, limit: clampLimit(query.limit ?? MAX_LIMIT) }) as PatientRow[];

  return toCsv(
    CSV_COLUMNS,
    rows.map((row) => {
      const patient = toPatient(row);
      return [
        patient.mrn,
        patient.firstName,
        patient.lastName,
        patient.dob,
        patient.ssn,
        patient.phone,
        patient.email,
        `${patient.addressStreet}, ${patient.addressCity}, ${patient.addressState} ${patient.addressZip}`,
        patient.insuranceCarrier,
        patient.insuranceMemberId,
        patient.primaryConditions.join("; "),
        patient.medications.join("; "),
        patient.allergies.join("; "),
      ];
    }),
  );
}

/** Hard-deletes a patient; notes and appointments follow via ON DELETE CASCADE. */
export function deletePatient(
  idOrMrn: string,
  db: BetterSqlite3.Database = getDb(),
): { id: string; mrn: string; name: string } | null {
  const row = findPatientRow(idOrMrn, db);
  if (!row) return null;

  db.prepare("DELETE FROM patients WHERE id = ?").run(row.id);
  return { id: row.id, mrn: row.mrn, name: `${row.first_name} ${row.last_name}` };
}
