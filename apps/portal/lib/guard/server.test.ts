import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEED_PATIENT_COUNT } from "@/lib/db/seed";
import { createTestDb } from "@/lib/db/testing";

import {
  GUARD_DEV_DEFAULTS,
  getGuardServer,
  insecureDefaultsWarning,
  patientNameDictionary,
  resetGuardServer,
  resetGuardServerWarning,
  resolveGuardSecrets,
} from "./server";

const SECRET_VARS = [
  "GUARD_ORG_SECRET",
  "GUARD_VAULT_KEY",
  "GUARD_ADMIN_TOKEN",
  "GUARD_CONSOLE_ORIGIN",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of SECRET_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  resetGuardServer();
  resetGuardServerWarning();
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  resetGuardServer();
  vi.restoreAllMocks();
});

describe("resolveGuardSecrets", () => {
  it("uses the environment when it is configured", () => {
    const secrets = resolveGuardSecrets({
      GUARD_ORG_SECRET: "org",
      GUARD_VAULT_KEY: "vault",
      GUARD_ADMIN_TOKEN: "admin",
      GUARD_CONSOLE_ORIGIN: "https://console.example",
    });

    expect(secrets).toEqual({
      orgSecret: "org",
      vaultKey: "vault",
      adminToken: "admin",
      consoleOrigin: "https://console.example",
      fellBack: [],
    });
  });

  it("falls back to obviously-insecure defaults so a clean clone boots", () => {
    const secrets = resolveGuardSecrets({});

    expect(secrets.orgSecret).toBe(GUARD_DEV_DEFAULTS.GUARD_ORG_SECRET);
    expect(secrets.vaultKey).toBe(GUARD_DEV_DEFAULTS.GUARD_VAULT_KEY);
    expect(secrets.adminToken).toBe(GUARD_DEV_DEFAULTS.GUARD_ADMIN_TOKEN);
    expect(secrets.fellBack).toEqual(["GUARD_ORG_SECRET", "GUARD_VAULT_KEY", "GUARD_ADMIN_TOKEN"]);
    // Nobody can mistake these for real secrets, which is the point.
    for (const value of Object.values(GUARD_DEV_DEFAULTS)) {
      expect(value).toContain("dev-only");
      expect(value).toContain("do-not-deploy");
    }
  });

  it("treats a blank or whitespace value as missing", () => {
    const secrets = resolveGuardSecrets({
      GUARD_ORG_SECRET: "",
      GUARD_VAULT_KEY: "   ",
      GUARD_ADMIN_TOKEN: "admin",
      GUARD_CONSOLE_ORIGIN: "  ",
    });

    expect(secrets.fellBack).toEqual(["GUARD_ORG_SECRET", "GUARD_VAULT_KEY"]);
    expect(secrets.adminToken).toBe("admin");
    // No console origin means same-origin only — never a wildcard.
    expect(secrets.consoleOrigin).toBeUndefined();
  });

  it("names every variable that fell back in the warning", () => {
    const warning = insecureDefaultsWarning(["GUARD_ORG_SECRET", "GUARD_ADMIN_TOKEN"]);

    expect(warning).toContain("GUARD_ORG_SECRET");
    expect(warning).toContain("GUARD_ADMIN_TOKEN");
    expect(warning).toContain(".env.example");
  });
});

describe("getGuardServer", () => {
  it("memoises one server for the process", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getGuardServer()).toBe(getGuardServer());
  });

  it("warns once about the insecure defaults, not once per rebuild", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    getGuardServer();
    resetGuardServer();
    getGuardServer();

    // Two one-time warnings on the first build, none on the rebuild: the
    // guard's own secrets, and the portal's mock-session signing key (Phase 6).
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("insecure development defaults");
    expect(messages[1]).toContain("development key");
  });

  it("stays quiet when the environment is configured", () => {
    process.env.GUARD_ORG_SECRET = "org";
    process.env.GUARD_VAULT_KEY = "vault";
    process.env.GUARD_ADMIN_TOKEN = "admin";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    getGuardServer();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("patientNameDictionary", () => {
  it("hands the classifier every patient's full name", () => {
    const db = createTestDb();
    try {
      const names = patientNameDictionary(db);

      expect(names).toHaveLength(SEED_PATIENT_COUNT);
      const first = db.prepare("SELECT first_name, last_name FROM patients LIMIT 1").get() as {
        first_name: string;
        last_name: string;
      };
      expect(names).toContain(`${first.first_name} ${first.last_name}`);
      // Full names only — a bare surname in a note is not evidence of a person.
      expect(names.every((name) => name.includes(" "))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("picks up a patient added after the server was built", () => {
    const db = createTestDb();
    try {
      db.prepare(
        `INSERT INTO patients (
           id, mrn, first_name, last_name, dob, ssn, phone, email,
           address_street, address_city, address_state, address_zip,
           insurance_carrier, insurance_member_id,
           primary_conditions, medications, allergies, created_at
         ) VALUES (
           'new-1', 'LM-999999', 'Newly', 'Registered', '1990-01-01', '900-00-0001',
           '(206) 555-0100', 'newly@example.com', '1 New St', 'Portland', 'OR', '97201',
           'Northwater Health', 'NEW000000001', '[]', '[]', '[]', '2026-01-01T00:00:00.000Z'
         )`,
      ).run();

      expect(patientNameDictionary(db)).toContain("Newly Registered");
    } finally {
      db.close();
    }
  });

  it("returns nothing rather than throwing when the table is missing", () => {
    const db = new Database(":memory:");
    try {
      expect(patientNameDictionary(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
