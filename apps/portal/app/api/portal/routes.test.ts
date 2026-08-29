import { describe, expect, it } from "vitest";

import { POST as addNote } from "./add-note/route";
import { GET as appointments } from "./appointments/route";
import { POST as deletePatientRoute } from "./delete/route";
import { GET as exportCsv } from "./export/route";
import { GET as getPatientRoute } from "./get/route";
import { GET as search } from "./search/route";
import { POST as update } from "./update/route";

/**
 * Route-handler tests. The handlers are plain functions over `Request`, so they
 * are called directly — no dev server, no fetch. `vitest.setup.ts` has already
 * pointed the data layer at an in-memory, freshly seeded database.
 */

const BASE = "http://localhost:3000";

function get(path: string): Request {
  return new Request(`${BASE}${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/portal/search", () => {
  it("returns the seeded roster", async () => {
    const response = search(get("/api/portal/search?limit=500"));
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(60);
    expect(body.patients).toHaveLength(60);
  });

  it("filters by condition", async () => {
    const body = await json(search(get("/api/portal/search?condition=hypertension&limit=500")));
    const patients = body.patients as { primaryConditions: string[] }[];

    expect(patients.length).toBeGreaterThanOrEqual(15);
    expect(patients.length).toBeLessThan(60);
    for (const patient of patients) {
      expect(patient.primaryConditions.join(" ").toLowerCase()).toContain("hypertension");
    }
  });

  it("returns an empty list for a miss instead of an error", async () => {
    const response = search(get("/api/portal/search?text=zzz-nobody"));
    expect(response.status).toBe(200);
    expect((await json(response)).patients).toEqual([]);
  });
});

describe("GET /api/portal/get", () => {
  it("returns a full record by MRN", async () => {
    const response = getPatientRoute(get("/api/portal/get?id=LM-100001"));
    expect(response.status).toBe(200);

    const patient = (await json(response)).patient as {
      mrn: string;
      ssn: string;
      notes: unknown[];
    };
    expect(patient.mrn).toBe("LM-100001");
    expect(patient.notes.length).toBeGreaterThan(0);
    // Phase 1 is deliberately unguarded: the SSN comes back in the clear.
    expect(patient.ssn).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
  });

  it("404s on an unknown MRN", async () => {
    const response = getPatientRoute(get("/api/portal/get?id=LM-999999"));
    expect(response.status).toBe(404);

    const body = await json(response);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("LM-999999");
  });

  it("400s when 'id' is missing", async () => {
    const response = getPatientRoute(get("/api/portal/get"));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/portal/update", () => {
  it("updates flat fields and echoes what changed", async () => {
    const response = await update(
      post("/api/portal/update", { id: "LM-100010", phone: "(415) 555-0177" }),
    );
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.updated).toEqual(["phone"]);
    expect((body.patient as { phone: string }).phone).toBe("(415) 555-0177");
  });

  it("accepts the nested `fields` shape the WebMCP tool posts", async () => {
    const response = await update(
      post("/api/portal/update", { id: "LM-100011", fields: { addressCity: "Lakeside" } }),
    );
    const patient = (await json(response)).patient as { addressCity: string };
    expect(patient.addressCity).toBe("Lakeside");
  });

  it("404s on an unknown patient", async () => {
    const response = await update(post("/api/portal/update", { id: "LM-999999", phone: "x" }));
    expect(response.status).toBe(404);
  });

  it("400s when no editable field is supplied", async () => {
    const response = await update(post("/api/portal/update", { id: "LM-100010", ssn: "1" }));
    expect(response.status).toBe(400);
    expect(String((await json(response)).error)).toContain("editable");
  });

  it("400s on a malformed body", async () => {
    expect((await update(post("/api/portal/update", "not json"))).status).toBe(400);
    expect((await update(post("/api/portal/update", { phone: "x" }))).status).toBe(400);
  });
});

describe("POST /api/portal/add-note", () => {
  it("appends a note and returns 201", async () => {
    const response = await addNote(
      post("/api/portal/add-note", {
        patientId: "LM-100012",
        body: "Called about refill.",
        author: "Dr. Alicia Reyes",
      }),
    );
    expect(response.status).toBe(201);

    const note = (await json(response)).note as { body: string; author: string };
    expect(note.body).toBe("Called about refill.");
    expect(note.author).toBe("Dr. Alicia Reyes");

    const detail = (await json(getPatientRoute(get("/api/portal/get?id=LM-100012")))).patient;
    const notes = (detail as { notes: { body: string }[] }).notes;
    expect(notes[0].body).toBe("Called about refill.");
  });

  it("404s on an unknown patient", async () => {
    const response = await addNote(
      post("/api/portal/add-note", { patientId: "LM-999999", body: "orphan" }),
    );
    expect(response.status).toBe(404);
  });

  it("400s without note text", async () => {
    const response = await addNote(post("/api/portal/add-note", { patientId: "LM-100012" }));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/portal/appointments", () => {
  it("returns upcoming appointments soonest first", async () => {
    const body = await json(appointments(get("/api/portal/appointments")));
    const rows = body.appointments as { scheduledAt: string }[];

    expect(rows.length).toBeGreaterThan(0);
    const times = rows.map((r) => r.scheduledAt);
    expect(times).toEqual([...times].sort());
  });

  it("narrows to this week", async () => {
    const week = (await json(appointments(get("/api/portal/appointments?withinDays=7"))))
      .appointments as unknown[];
    const all = (await json(appointments(get("/api/portal/appointments"))))
      .appointments as unknown[];

    expect(week.length).toBeGreaterThan(0);
    expect(week.length).toBeLessThan(all.length);
  });
});

describe("GET /api/portal/export", () => {
  it("returns a CSV attachment", async () => {
    const response = exportCsv(get("/api/portal/export?limit=500"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("lakeside-patients-");

    const csv = await response.text();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toContain("mrn,first_name,last_name");
    expect(lines).toHaveLength(61);
  });

  it("honours the same filters as search", async () => {
    const csv = await exportCsv(get("/api/portal/export?condition=hypertension&limit=500")).text();
    const rows = csv.trimEnd().split("\r\n").slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.length).toBeLessThan(60);
  });
});

describe("POST /api/portal/delete", () => {
  it("deletes a patient and reports what went", async () => {
    const response = await deletePatientRoute(post("/api/portal/delete", { id: "LM-100060" }));
    expect(response.status).toBe(200);

    const deleted = (await json(response)).deleted as { mrn: string; name: string };
    expect(deleted.mrn).toBe("LM-100060");
    expect(deleted.name).toBeTruthy();

    expect(getPatientRoute(get("/api/portal/get?id=LM-100060")).status).toBe(404);
  });

  it("404s on an unknown patient", async () => {
    const response = await deletePatientRoute(post("/api/portal/delete", { id: "LM-999999" }));
    expect(response.status).toBe(404);
  });

  it("400s without an id", async () => {
    expect((await deletePatientRoute(post("/api/portal/delete", {}))).status).toBe(400);
  });
});
