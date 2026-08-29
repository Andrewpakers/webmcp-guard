import type { LogRecord } from "@webmcp-guard/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { getPatient } from "@/lib/db/repository";
import type { PatientDetail } from "@/lib/db/types";
import { PORTAL_LOG_APP, UI_REVEAL_TOOL } from "@/lib/guard/audit";
import { getGuardStorage } from "@/lib/guard/server";
import { personaCookieHeaders } from "@/lib/session/cookie";
import { findPersona } from "@/lib/session/personas";

import { POST } from "./route";

/**
 * The reveal route: the only path from the browser to a masked-at-rest value.
 *
 * Two things are actually under test — that the value comes back, and that the
 * access is *written down* with the identity the server resolved rather than the
 * one the caller claimed. The second is the whole point of the feature.
 *
 * `vitest.setup.ts` points the data layer at an in-memory, freshly seeded
 * database, and `lib/guard/server.ts` adopts that same connection, so the audit
 * entries these tests read back are the ones the route just wrote.
 */

const URL = "http://localhost:3000/api/portal/reveal-field";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** `name=value` pairs for a persona, as a browser would send them back. */
function cookieHeader(personaId: string): string {
  const persona = findPersona(personaId);
  if (persona === undefined) throw new Error(`no persona ${personaId}`);
  return personaCookieHeaders(persona, { secure: false })
    .map((header) => header.split(";")[0])
    .join("; ");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Every `ui_reveal_field` entry in the audit log, newest first. */
async function revealEntries(): Promise<LogRecord[]> {
  const page = await getGuardStorage().queryLogs({
    app: PORTAL_LOG_APP,
    tool: UI_REVEAL_TOOL,
    limit: 200,
  });
  return page.entries;
}

let patient: PatientDetail;

beforeAll(() => {
  const found = getPatient("LM-100001");
  if (found === null) throw new Error("seed data missing LM-100001");
  patient = found;
});

describe("POST /api/portal/reveal-field", () => {
  it("returns the real value and records the reveal in the guard's audit log", async () => {
    const before = (await revealEntries()).length;

    const response = await POST(post({ patientId: patient.mrn, field: "ssn" }));
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.value).toBe(patient.ssn);
    expect(body.value).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    expect(body.mrn).toBe(patient.mrn);
    expect(body.field).toBe("ssn");

    const entries = await revealEntries();
    expect(entries).toHaveLength(before + 1);

    const entry = entries[0];
    expect(entry.app).toBe("lakeside-portal");
    expect(entry.tool).toBe("ui_reveal_field");
    expect(entry.verdict).toBe("allow");
    expect(entry.dataClasses).toEqual(["ssn"]);
    expect(entry.status).toBe("complete");
    // No cookie: the portal has no login wall, so "not signed in" is Dr. Reyes.
    expect(entry.session).toEqual({ userId: "dr-reyes", role: "physician" });
    expect(entry.message).toContain(patient.mrn);
    expect(entry.message).toContain("SSN");
    // An audit entry that copied the value would be a second place it lives.
    expect(entry.message).not.toContain(patient.ssn);
    expect(JSON.stringify(entry)).not.toContain(patient.ssn);
  });

  it("files the reveal under the persona in the signed cookie, not the one the body claims", async () => {
    const response = await POST(
      post(
        {
          patientId: patient.id,
          field: "phone",
          // A page script naming the identity it would prefer to be audited as.
          session: { userId: "dr-reyes", role: "physician" },
        },
        { cookie: cookieHeader("sam-levin") },
      ),
    );

    expect(response.status).toBe(200);
    expect((await json(response)).value).toBe(patient.phone);

    const entry = (await revealEntries())[0];
    expect(entry.session).toEqual({ userId: "sam-levin", role: "billing" });
    expect(entry.dataClasses).toEqual(["phone"]);
    expect(entry.message).toContain("Sam Levin");
    expect(entry.message).toContain("billing");
  });

  it("ignores a tampered cookie and falls back to the default persona", async () => {
    const tampered = `${cookieHeader("sam-levin").split(".")[0]}.not-a-signature`;
    const response = await POST(
      post({ patientId: patient.mrn, field: "email" }, { cookie: tampered }),
    );

    expect(response.status).toBe(200);
    expect((await json(response)).value).toBe(patient.email);
    expect((await revealEntries())[0].session).toEqual({ userId: "dr-reyes", role: "physician" });
  });

  it("records the user agent it was called with, and never claims an agent id", async () => {
    const response = await POST(
      post({ patientId: patient.mrn, field: "dob" }, { "user-agent": "Chromium/151 (test)" }),
    );
    expect(response.status).toBe(200);
    expect((await json(response)).value).toBe(patient.dob);

    const entry = (await revealEntries())[0];
    expect(entry.agent.userAgent).toBe("Chromium/151 (test)");
    expect(entry.agent.agentId).toBeUndefined();
    expect(entry.dataClasses).toEqual(["dob"]);
  });

  it("writes one entry per reveal, so re-masking and revealing again is auditable", async () => {
    const before = (await revealEntries()).length;

    await POST(post({ patientId: patient.mrn, field: "ssn" }));
    await POST(post({ patientId: patient.mrn, field: "ssn" }));

    const entries = await revealEntries();
    expect(entries).toHaveLength(before + 2);
    expect(new Set(entries.slice(0, 2).map((entry) => entry.id)).size).toBe(2);
  });

  it("404s an unknown patient, and logs nothing", async () => {
    const before = (await revealEntries()).length;

    const response = await POST(post({ patientId: "LM-999999", field: "ssn" }));
    expect(response.status).toBe(404);
    expect(String((await json(response)).error)).toContain("LM-999999");
    expect(await revealEntries()).toHaveLength(before);
  });

  it("400s a field that is not revealable, and logs nothing", async () => {
    const before = (await revealEntries()).length;

    for (const field of ["mrn", "name", "notes", "", 7, undefined]) {
      const response = await POST(post({ patientId: patient.mrn, field }));
      expect(response.status).toBe(400);
      expect(String((await json(response)).error)).toContain("ssn, dob, phone, email");
    }

    expect(await revealEntries()).toHaveLength(before);
  });

  it("400s a missing patient id or a body that is not a JSON object", async () => {
    const noPatient = await POST(post({ field: "ssn" }));
    expect(noPatient.status).toBe(400);
    expect(String((await json(noPatient)).error)).toContain("patientId");

    const notJson = await POST(post("not json at all"));
    expect(notJson.status).toBe(400);

    const notAnObject = await POST(post(["ssn"]));
    expect(notAnObject.status).toBe(400);
  });
});
