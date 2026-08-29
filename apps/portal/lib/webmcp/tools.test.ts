import { describe, expect, it, vi } from "vitest";

import { type PortalToolName, createPortalTools } from "./tools";

/**
 * Exercises what each `execute` actually does: which portal endpoint it calls,
 * what shape it hands back, and whether it tells the page to re-render.
 *
 * Since Phase 3 every tool resolves with **structured data**, not a formatted
 * string: the guard's field-name classifier can only recognise `ssn`, `dob` or
 * `mrn` if the tool returns real keys (docs/04). The assertions below are
 * therefore about shape, and the `summary` string is the one human-readable
 * field.
 */

interface StubResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

function stubFetch(responder: (url: string, init?: RequestInit) => StubResponse) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const stub = responder(url, init);
    const status = stub.status ?? 200;
    const body = stub.text ?? JSON.stringify(stub.json ?? {});
    return new Response(body, {
      status,
      headers: { "content-type": stub.text ? "text/csv" : "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function toolsByName(context: Parameters<typeof createPortalTools>[0] = {}) {
  return new Map(createPortalTools(context).map((t) => [t.name as PortalToolName, t]));
}

const signal = new AbortController().signal;
const opts = { signal };

/** A patient row as `app/api/portal/*` returns it. */
function patientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "internal-uuid-1",
    mrn: "LM-100001",
    firstName: "Ada",
    lastName: "Whitfield",
    dob: "1985-04-12",
    ssn: "927-78-1337",
    phone: "(206) 555-0142",
    email: "ada.whitfield1@example.com",
    addressStreet: "123 Elm St",
    addressCity: "Portland",
    addressState: "OR",
    addressZip: "97201",
    insuranceCarrier: "Northwater Health",
    insuranceMemberId: "ABC123456789",
    primaryConditions: ["Hypertension"],
    medications: ["Lisinopril 10 mg daily"],
    allergies: ["Penicillin"],
    nextAppointmentAt: "2026-09-03T15:00:00.000Z",
    ...overrides,
  };
}

describe("search_patients", () => {
  it("builds the query string and returns structured summaries", async () => {
    const { impl, calls } = stubFetch(() => ({
      json: {
        ok: true,
        patients: [patientRow(), patientRow({ mrn: "LM-100004", firstName: "Grace" })],
        total: 21,
      },
    }));
    const tool = toolsByName({ fetchImpl: impl }).get("search_patients");

    const output = (await tool?.execute({ condition: "hypertension", limit: 10 }, opts)) as {
      summary: string;
      returned: number;
      total: number;
      patients: Record<string, unknown>[];
    };

    expect(calls[0].url).toBe("/api/portal/search?condition=hypertension&limit=10");
    expect(output.summary).toBe("2 patient(s) returned of 21 matching.");
    expect(output.returned).toBe(2);
    expect(output.total).toBe(21);
    expect(output.patients[0]).toEqual({
      mrn: "LM-100001",
      name: "Ada Whitfield",
      dob: "1985-04-12",
      phone: "(206) 555-0142",
      primaryConditions: ["Hypertension"],
      nextAppointmentAt: "2026-09-03T15:00:00.000Z",
    });
  });

  it("returns one `name` field rather than split first/last, and no internal id", async () => {
    const { impl } = stubFetch(() => ({ json: { ok: true, patients: [patientRow()], total: 1 } }));
    const tool = toolsByName({ fetchImpl: impl }).get("search_patients");

    const output = (await tool?.execute({}, opts)) as { patients: Record<string, unknown>[] };
    // Split names would tokenize to two unrelated tokens, neither of which
    // could be used to look the person up again.
    expect(Object.keys(output.patients[0])).not.toContain("firstName");
    expect(Object.keys(output.patients[0])).not.toContain("id");
  });

  it("defaults the limit and drops empty filters", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, patients: [], total: 0 } }));
    const tool = toolsByName({ fetchImpl: impl }).get("search_patients");

    await tool?.execute({ text: "   " }, opts);
    expect(calls[0].url).toBe("/api/portal/search?limit=25");
  });
});

describe("get_patient", () => {
  const detail = { ...patientRow(), notes: [], appointments: [] };

  it("returns the chart split into patient, notes and appointments", async () => {
    const { impl, calls } = stubFetch(() => ({
      json: {
        ok: true,
        patient: {
          ...detail,
          notes: [
            {
              id: "n1",
              patientId: "internal-uuid-1",
              authoredAt: "2026-08-01T00:00:00.000Z",
              author: "Dr. Alicia Reyes",
              body: "Called about refill.",
            },
          ],
          appointments: [
            {
              id: "a1",
              patientId: "internal-uuid-1",
              scheduledAt: "2026-09-03T15:00:00.000Z",
              reason: "Lab draw",
              provider: "Dr. Marcus Tan",
              status: "scheduled",
            },
          ],
        },
      },
    }));
    const tool = toolsByName({ fetchImpl: impl }).get("get_patient");

    const output = (await tool?.execute({ patient: "LM-100001" }, opts)) as {
      summary: string;
      patient: Record<string, unknown>;
      notes: Record<string, unknown>[];
      appointments: Record<string, unknown>[];
    };

    expect(calls[0].url).toBe("/api/portal/get?id=LM-100001");
    expect(output.summary).toContain("LM-100001");
    expect(output.summary).toContain("1 visit note(s)");
    // The raw chart still contains the SSN — the guard, not the tool, decides
    // what the agent sees.
    expect(output.patient.ssn).toBe("927-78-1337");
    expect(output.patient.name).toBe("Ada Whitfield");
    expect(output.notes[0]).toEqual({
      authoredAt: "2026-08-01T00:00:00.000Z",
      author: "Dr. Alicia Reyes",
      body: "Called about refill.",
    });
    expect(output.appointments[0]).toEqual({
      scheduledAt: "2026-09-03T15:00:00.000Z",
      reason: "Lab draw",
      provider: "Dr. Marcus Tan",
      status: "scheduled",
    });
  });

  it("passes a detokenized full name through to the API as the identifier", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, patient: detail } }));
    const tool = toolsByName({ fetchImpl: impl }).get("get_patient");

    // What the tool receives after `tok_name_…` has been resolved at the gate.
    await tool?.execute({ patient: "Tricia Bashirian" }, opts);
    expect(calls[0].url).toBe("/api/portal/get?id=Tricia+Bashirian");
  });

  it("rejects a missing identifier with a message an agent can act on", async () => {
    const tool = toolsByName().get("get_patient");
    await expect(tool?.execute({}, opts)).rejects.toThrow(/'patient' is required/);
    await expect(tool?.execute({}, opts)).rejects.toThrow(/tok_mrn_/);
  });

  it("surfaces the API error text rather than a bare status code", async () => {
    const { impl } = stubFetch(() => ({
      status: 404,
      json: { ok: false, error: "No patient found for 'LM-999999'." },
    }));
    const tool = toolsByName({ fetchImpl: impl }).get("get_patient");

    await expect(tool?.execute({ patient: "LM-999999" }, opts)).rejects.toThrow(
      "No patient found for 'LM-999999'.",
    );
  });
});

describe("update_patient", () => {
  it("posts the nested fields shape and returns the updated record", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: {
        ok: true,
        patient: { ...patientRow(), notes: [], appointments: [] },
        updated: ["phone"],
      },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("update_patient");

    const output = (await tool?.execute(
      { patient: "LM-100001", fields: { phone: "(206) 555-0142" } },
      opts,
    )) as { summary: string; updated: string[]; patient: Record<string, unknown> };

    expect(calls[0].url).toBe("/api/portal/update");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      id: "LM-100001",
      fields: { phone: "(206) 555-0142" },
    });
    expect(onMutation).toHaveBeenCalledWith({ tool: "update_patient", target: "LM-100001" });
    expect(output.summary).toBe("Updated phone for LM-100001.");
    expect(output.updated).toEqual(["phone"]);
    expect(output.patient.mrn).toBe("LM-100001");
  });

  it("explains the editable field list when `fields` is not an object", async () => {
    const tool = toolsByName().get("update_patient");
    await expect(tool?.execute({ patient: "LM-100001", fields: "phone" }, opts)).rejects.toThrow(
      /Editable fields: firstName/,
    );
  });
});

describe("add_visit_note", () => {
  it("posts the note and returns it as an object", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: {
        ok: true,
        note: {
          id: "n1",
          patientId: "internal-uuid-1",
          authoredAt: "2026-08-29T12:00:00.000Z",
          author: "Dr. Alicia Reyes",
          body: "Called about refill.",
        },
      },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("add_visit_note");

    const output = (await tool?.execute(
      { patient: "LM-100001", note: "Called about refill.", author: "Dr. Alicia Reyes" },
      opts,
    )) as { summary: string; note: Record<string, unknown> };

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      patientId: "LM-100001",
      body: "Called about refill.",
      author: "Dr. Alicia Reyes",
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(output.summary).toContain("Note added to LM-100001");
    expect(output.note.body).toBe("Called about refill.");
    expect(output.note).not.toHaveProperty("patientId");
  });

  it("requires note text", async () => {
    const tool = toolsByName().get("add_visit_note");
    await expect(tool?.execute({ patient: "LM-100001", note: "  " }, opts)).rejects.toThrow(
      /'note' is required/,
    );
  });
});

describe("list_appointments", () => {
  const appointment = {
    id: "a1",
    patientId: "internal-uuid-1",
    scheduledAt: "2026-09-03T15:00:00.000Z",
    reason: "Lab draw",
    provider: "Dr. Marcus Tan",
    status: "scheduled",
    patientMrn: "LM-100001",
    patientName: "Ada Whitfield",
  };

  it("maps the window enum onto a day horizon", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, appointments: [] } }));
    const tools = toolsByName({ fetchImpl: impl });
    const tool = tools.get("list_appointments");

    await tool?.execute({ window: "this_week" }, opts);
    expect(calls[0].url).toBe("/api/portal/appointments?withinDays=7&limit=50");

    await tool?.execute({ window: "today" }, opts);
    expect(calls[1].url).toBe("/api/portal/appointments?withinDays=1&limit=50");

    await tool?.execute({ window: "all", patient: "LM-100001" }, opts);
    expect(calls[2].url).toBe("/api/portal/appointments?patientId=LM-100001&limit=50");
  });

  it("returns appointments with the patient identity as its own fields", async () => {
    const { impl } = stubFetch(() => ({ json: { ok: true, appointments: [appointment] } }));
    const tool = toolsByName({ fetchImpl: impl }).get("list_appointments");

    const output = (await tool?.execute({}, opts)) as {
      summary: string;
      window: string;
      appointments: Record<string, unknown>[];
    };

    expect(output.summary).toBe("1 appointment(s) in window 'this_week'.");
    expect(output.appointments[0]).toEqual({
      scheduledAt: "2026-09-03T15:00:00.000Z",
      reason: "Lab draw",
      provider: "Dr. Marcus Tan",
      status: "scheduled",
      patientMrn: "LM-100001",
      patientName: "Ada Whitfield",
    });
  });

  it("falls back to this_week for an unknown window", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, appointments: [] } }));
    const tool = toolsByName({ fetchImpl: impl }).get("list_appointments");

    const output = (await tool?.execute({ window: "next_century" }, opts)) as { window: string };
    expect(calls[0].url).toContain("withinDays=7");
    expect(output.window).toBe("this_week");
  });

  it("advertises its windows as an enum", () => {
    const tool = toolsByName().get("list_appointments");
    const properties = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.window.enum).toEqual(["today", "this_week", "next_30_days", "all"]);
  });
});

describe("export_patients", () => {
  it("returns the CSV in its own field with a row count", async () => {
    const csv = "mrn,first_name\r\nLM-100001,Ada\r\nLM-100004,Grace\r\n";
    const { impl, calls } = stubFetch(() => ({ text: csv }));
    const tool = toolsByName({ fetchImpl: impl }).get("export_patients");

    const output = (await tool?.execute({ condition: "hypertension" }, opts)) as {
      summary: string;
      rows: number;
      csv: string;
    };

    expect(calls[0].url).toBe("/api/portal/export?condition=hypertension&limit=500");
    expect(output.summary).toBe("Exported 2 patient row(s) as CSV.");
    expect(output.rows).toBe(2);
    expect(output.csv).toBe(csv);
  });

  it("throws on a failed export", async () => {
    const { impl } = stubFetch(() => ({ status: 500, text: "boom" }));
    const tool = toolsByName({ fetchImpl: impl }).get("export_patients");
    await expect(tool?.execute({}, opts)).rejects.toThrow("Export failed with HTTP 500.");
  });
});

describe("delete_patient", () => {
  it("deletes and reports what went", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, deleted: { mrn: "LM-100001", name: "Ada Byron" } },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("delete_patient");

    const output = (await tool?.execute({ patient: "LM-100001" }, opts)) as {
      summary: string;
      deleted: { mrn: string; name: string };
    };

    expect(calls[0].url).toBe("/api/portal/delete");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: "LM-100001" });
    expect(onMutation).toHaveBeenCalledWith({ tool: "delete_patient", target: "LM-100001" });
    expect(output.summary).toContain("Deleted patient LM-100001");
    expect(output.deleted).toEqual({ mrn: "LM-100001", name: "Ada Byron" });
  });

  it("warns the agent off casual deletion in its description", () => {
    const tool = toolsByName().get("delete_patient");
    expect(tool?.description).toMatch(/cannot be undone/i);
    expect(tool?.description).toMatch(/never call this/i);
  });
});

describe("tool descriptions", () => {
  it("teach the agent what a token is and that it can be passed back", () => {
    for (const tool of createPortalTools()) {
      if (tool.name === "export_patients") continue; // no identifier argument
      expect(tool.description).toContain("tok_mrn_99aa00bb");
      expect(tool.description).toMatch(/the same person always produces the same token/i);
      expect(tool.description).toMatch(/pass one back verbatim/i);
    }
  });

  it("explain that coarsened values are deliberate", () => {
    const tool = createPortalTools().find((candidate) => candidate.name === "get_patient");
    expect(tool?.description).toContain("age 40-49");
  });
});

describe("baseUrl", () => {
  it("can be pointed at an absolute origin", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, patients: [], total: 0 } }));
    const tool = toolsByName({
      fetchImpl: impl,
      baseUrl: "https://lakeside.example/api/portal",
    }).get("search_patients");

    await tool?.execute({}, opts);
    expect(calls[0].url).toBe("https://lakeside.example/api/portal/search?limit=25");
  });
});
