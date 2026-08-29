import { describe, expect, it, vi } from "vitest";

import { type PortalToolName, createPortalTools } from "./tools";

/**
 * Exercises what each `execute` actually does: which portal endpoint it calls,
 * what it hands back to the agent, and whether it tells the page to re-render.
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

describe("search_patients", () => {
  it("builds the query string and summarises the result", async () => {
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, patients: [{ mrn: "LM-100001" }, { mrn: "LM-100004" }], total: 21 },
    }));
    const tool = toolsByName({ fetchImpl: impl }).get("search_patients");

    const output = await tool?.execute({ condition: "hypertension", limit: 10 }, opts);

    expect(calls[0].url).toBe("/api/portal/search?condition=hypertension&limit=10");
    expect(String(output)).toContain("2 patient(s) returned of 21 matching.");
    expect(String(output)).toContain("LM-100001");
  });

  it("defaults the limit and drops empty filters", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, patients: [], total: 0 } }));
    const tool = toolsByName({ fetchImpl: impl }).get("search_patients");

    await tool?.execute({ text: "   " }, opts);
    expect(calls[0].url).toBe("/api/portal/search?limit=25");
  });
});

describe("get_patient", () => {
  it("returns the raw record — SSN and all — in Phase 1", async () => {
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, patient: { mrn: "LM-100001", ssn: "900-12-3456" } },
    }));
    const tool = toolsByName({ fetchImpl: impl }).get("get_patient");

    const output = await tool?.execute({ patient: "LM-100001" }, opts);

    expect(calls[0].url).toBe("/api/portal/get?id=LM-100001");
    expect(String(output)).toContain("900-12-3456");
  });

  it("rejects a missing identifier with a message an agent can act on", async () => {
    const tool = toolsByName().get("get_patient");
    await expect(tool?.execute({}, opts)).rejects.toThrow(/'patient' is required/);
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
  it("posts the nested fields shape and notifies the page", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, patient: { mrn: "LM-100001" }, updated: ["phone"] },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("update_patient");

    const output = await tool?.execute(
      { patient: "LM-100001", fields: { phone: "(206) 555-0142" } },
      opts,
    );

    expect(calls[0].url).toBe("/api/portal/update");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      id: "LM-100001",
      fields: { phone: "(206) 555-0142" },
    });
    expect(onMutation).toHaveBeenCalledWith({ tool: "update_patient", target: "LM-100001" });
    expect(String(output)).toContain("Updated phone for LM-100001.");
  });

  it("explains the editable field list when `fields` is not an object", async () => {
    const tool = toolsByName().get("update_patient");
    await expect(tool?.execute({ patient: "LM-100001", fields: "phone" }, opts)).rejects.toThrow(
      /Editable fields: firstName/,
    );
  });
});

describe("add_visit_note", () => {
  it("posts the note and notifies the page", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, note: { id: "n1", body: "Called about refill." } },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("add_visit_note");

    const output = await tool?.execute(
      { patient: "LM-100001", note: "Called about refill.", author: "Dr. Alicia Reyes" },
      opts,
    );

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      patientId: "LM-100001",
      body: "Called about refill.",
      author: "Dr. Alicia Reyes",
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain("Note added to LM-100001.");
  });

  it("requires note text", async () => {
    const tool = toolsByName().get("add_visit_note");
    await expect(tool?.execute({ patient: "LM-100001", note: "  " }, opts)).rejects.toThrow(
      /'note' is required/,
    );
  });
});

describe("list_appointments", () => {
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

  it("falls back to this_week for an unknown window", async () => {
    const { impl, calls } = stubFetch(() => ({ json: { ok: true, appointments: [] } }));
    const tool = toolsByName({ fetchImpl: impl }).get("list_appointments");

    const output = await tool?.execute({ window: "next_century" }, opts);
    expect(calls[0].url).toContain("withinDays=7");
    expect(String(output)).toContain("window 'this_week'");
  });

  it("advertises its windows as an enum", () => {
    const tool = toolsByName().get("list_appointments");
    const properties = tool?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.window.enum).toEqual(["today", "this_week", "next_30_days", "all"]);
  });
});

describe("export_patients", () => {
  it("returns CSV text with a row count", async () => {
    const csv = "mrn,first_name\r\nLM-100001,Ada\r\nLM-100004,Grace\r\n";
    const { impl, calls } = stubFetch(() => ({ text: csv }));
    const tool = toolsByName({ fetchImpl: impl }).get("export_patients");

    const output = await tool?.execute({ condition: "hypertension" }, opts);

    expect(calls[0].url).toBe("/api/portal/export?condition=hypertension&limit=500");
    expect(String(output)).toContain("Exported 2 patient row(s) as CSV.");
    expect(String(output)).toContain("LM-100001,Ada");
  });

  it("throws on a failed export", async () => {
    const { impl } = stubFetch(() => ({ status: 500, text: "boom" }));
    const tool = toolsByName({ fetchImpl: impl }).get("export_patients");
    await expect(tool?.execute({}, opts)).rejects.toThrow("Export failed with HTTP 500.");
  });
});

describe("delete_patient", () => {
  it("deletes with no confirmation step — the Phase 1 'before' behaviour", async () => {
    const onMutation = vi.fn();
    const { impl, calls } = stubFetch(() => ({
      json: { ok: true, deleted: { mrn: "LM-100001", name: "Ada Byron" } },
    }));
    const tool = toolsByName({ fetchImpl: impl, onMutation }).get("delete_patient");

    const output = await tool?.execute({ patient: "LM-100001" }, opts);

    expect(calls[0].url).toBe("/api/portal/delete");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: "LM-100001" });
    expect(onMutation).toHaveBeenCalledWith({ tool: "delete_patient", target: "LM-100001" });
    expect(String(output)).toContain("Deleted patient LM-100001 (Ada Byron)");
  });

  it("warns the agent off casual deletion in its description", () => {
    const tool = toolsByName().get("delete_patient");
    expect(tool?.description).toMatch(/cannot be undone/i);
    expect(tool?.description).toMatch(/never call this/i);
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
