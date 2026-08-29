/**
 * Domain types for the Lakeside Medical demo dataset.
 *
 * Every record in this app is synthetic — see `lib/db/seed.ts`. These types are
 * shared by the data-access layer, the API routes, and the WebMCP tools.
 */

/** A patient record, exactly as the host application stores it (raw, untransformed). */
export interface Patient {
  id: string;
  /** Medical record number, `LM-######`. Unique. */
  mrn: string;
  firstName: string;
  lastName: string;
  /** ISO date, `YYYY-MM-DD`. */
  dob: string;
  /** `###-##-####`. Always in the SSA-invalid 900-series — these are not real SSNs. */
  ssn: string;
  phone: string;
  email: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  insuranceCarrier: string;
  insuranceMemberId: string;
  primaryConditions: string[];
  medications: string[];
  allergies: string[];
  /** ISO datetime. */
  createdAt: string;
}

/** A free-text clinical note. Bodies deliberately embed PHI (see `lib/db/seed.ts`). */
export interface VisitNote {
  id: string;
  patientId: string;
  /** ISO datetime. */
  authoredAt: string;
  author: string;
  body: string;
}

export const APPOINTMENT_STATUSES = ["scheduled", "confirmed", "checked-in"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface Appointment {
  id: string;
  patientId: string;
  /** ISO datetime. */
  scheduledAt: string;
  reason: string;
  provider: string;
  status: AppointmentStatus;
}

/** An appointment joined with the minimum patient identity needed to render it. */
export interface AppointmentWithPatient extends Appointment {
  patientMrn: string;
  patientName: string;
}

/** A patient row as shown in list views and returned by `search_patients`. */
export interface PatientSummary {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  dob: string;
  phone: string;
  primaryConditions: string[];
  /** ISO datetime of the soonest future appointment, or `null` if none. */
  nextAppointmentAt: string | null;
}

/** A patient record with its notes and appointments attached. */
export interface PatientDetail extends Patient {
  notes: VisitNote[];
  appointments: Appointment[];
}

/** Filter accepted by `searchPatients` / `exportPatientsCsv`. */
export interface PatientQuery {
  /** Free text matched against name, MRN, email and phone (case-insensitive substring). */
  text?: string;
  /** Case-insensitive substring matched against `primary_conditions`. */
  condition?: string;
  /** Maximum rows to return. Defaults to 100. */
  limit?: number;
}

/** Fields `updatePatient` is allowed to change. Clinical fields are intentionally excluded. */
export interface PatientUpdate {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  insuranceCarrier?: string;
  insuranceMemberId?: string;
}

export interface AppointmentQuery {
  /** Only appointments scheduled between now and now + `withinDays`. */
  withinDays?: number;
  patientId?: string;
  limit?: number;
}
