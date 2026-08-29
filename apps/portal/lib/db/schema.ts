import type BetterSqlite3 from "better-sqlite3";

/**
 * Schema for the *host application's* tables. WebMCP Guard's own tables (policies,
 * logs, vault) live alongside these via `@webmcp-guard/storage-sqlite` and are
 * created by that package, not here.
 *
 * All statements are `IF NOT EXISTS` so `applySchema` is safe to run on every boot.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS patients (
  id                  TEXT PRIMARY KEY,
  mrn                 TEXT NOT NULL UNIQUE,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  dob                 TEXT NOT NULL,
  ssn                 TEXT NOT NULL,
  phone               TEXT NOT NULL,
  email               TEXT NOT NULL,
  address_street      TEXT NOT NULL,
  address_city        TEXT NOT NULL,
  address_state       TEXT NOT NULL,
  address_zip         TEXT NOT NULL,
  insurance_carrier   TEXT NOT NULL,
  insurance_member_id TEXT NOT NULL,
  primary_conditions  TEXT NOT NULL,
  medications         TEXT NOT NULL,
  allergies           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients (last_name, first_name);

CREATE TABLE IF NOT EXISTS visit_notes (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  authored_at TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visit_notes_patient ON visit_notes (patient_id, authored_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  reason       TEXT NOT NULL,
  provider     TEXT NOT NULL,
  status       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_scheduled ON appointments (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id, scheduled_at);
`;

/** Creates every table/index the portal needs, if it is not already there. */
export function applySchema(db: BetterSqlite3.Database): void {
  db.exec(SCHEMA_SQL);
}

/** True when the portal has no patient rows and therefore needs seeding. */
export function isDatabaseEmpty(db: BetterSqlite3.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM patients").get() as { count: number };
  return row.count === 0;
}
