import { WIRE_VERSION } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { getPatient, searchPatients } from "@/lib/db/repository";
import { resolveGuardSecrets } from "@/lib/guard/server";

import { GET, POST } from "./[...route]/route";

/**
 * The mounted guard API, exercised through the real Next route handlers.
 *
 * `vitest.setup.ts` pins `PORTAL_DB_PATH=:memory:`, and `lib/guard/server.ts`
 * adopts that same connection — so these tests prove the thing the portal
 * actually does: guard tables created inside the patient database, default
 * policy seeded on first request, no second store anywhere.
 */

const BASE = "http://localhost:3000/api/guard";
const APP = "lakeside-portal";

function guardRequest(
  segments: string[],
  payload: unknown,
): [Request, { params: Promise<{ route: string[] }> }] {
  const request = new Request(`${BASE}/${segments.join("/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: WIRE_VERSION, payload }),
  });
  return [request, { params: Promise.resolve({ route: segments }) }];
}

async function payloadOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { payload?: Record<string, unknown> };
  return body.payload ?? {};
}

describe("POST /api/guard/gate", () => {
  it("allows a benign tool and issues a call id", async () => {
    const response = await POST(
      ...guardRequest(["gate"], {
        app: "lakeside-portal",
        tool: "search_patients",
        args: { text: "hypertension" },
        toolTags: ["read", "phi"],
      }),
    );

    expect(response.status).toBe(200);
    const payload = await payloadOf(response);
    expect(payload.verdict).toBe("allow");
    expect(typeof payload.callId).toBe("string");
    expect(String(payload.callId).length).toBeGreaterThan(10);
    // Phase 2 returns the args untouched; Phase 3 detokenizes them here.
    expect(payload.args).toEqual({ text: "hypertension" });
  });

  it("holds delete_patient for human confirmation and issues a one-time id", async () => {
    const response = await POST(
      ...guardRequest(["gate"], {
        app: "lakeside-portal",
        tool: "delete_patient",
        args: { patient: "LM-100001" },
        toolTags: ["write", "destructive"],
      }),
    );

    expect(response.status).toBe(200);
    const payload = await payloadOf(response);
    expect(payload.verdict).toBe("require-confirmation");
    expect(payload.ruleIds).toContain("destructive-requires-confirmation");
    // The message is what the agent reads: prose, and a route to the human.
    expect(String(payload.message)).toContain("approved by the person using this page");
    expect(typeof payload.confirmationId).toBe("string");
    // Nothing runs until a person approves, so there are no args to run with.
    expect(payload.args).toBeUndefined();
  });

  it("asks for a justification before exporting, through the mounted route", async () => {
    const response = await POST(
      ...guardRequest(["gate"], {
        app: "lakeside-portal",
        tool: "export_patients",
        args: {},
        toolTags: ["read", "phi", "bulk", "destructive-adjacent"],
      }),
    );

    const payload = await payloadOf(response);
    expect(payload.verdict).toBe("require-justification");
    expect(String(payload.message)).toContain("at least 40 characters");
  });

  it("rejects a malformed envelope", async () => {
    const request = new Request(`${BASE}/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: WIRE_VERSION, payload: { tool: "search_patients" } }),
    });
    const response = await POST(request, { params: Promise.resolve({ route: ["gate"] }) });

    expect(response.status).toBe(400);
  });
});

describe("GET /api/guard/logs", () => {
  function logsRequest(token?: string): [Request, { params: Promise<{ route: string[] }> }] {
    const request = new Request(`${BASE}/logs?tool=delete_patient`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return [request, { params: Promise.resolve({ route: ["logs"] }) }];
  }

  it("refuses an unauthenticated read", async () => {
    const response = await GET(...logsRequest());
    expect(response.status).toBe(401);
  });

  it("shows the held call to an admin", async () => {
    // Make sure there is something to find, whatever order the tests ran in.
    await POST(
      ...guardRequest(["gate"], {
        app: "lakeside-portal",
        tool: "delete_patient",
        args: { patient: "LM-100002" },
        toolTags: ["write", "destructive"],
      }),
    );

    const response = await GET(...logsRequest(resolveGuardSecrets().adminToken));
    expect(response.status).toBe(200);

    const payload = (await payloadOf(response)) as unknown as {
      entries: { tool: string; verdict: string; app: string; message?: string }[];
    };
    expect(payload.entries.length).toBeGreaterThan(0);
    for (const entry of payload.entries) {
      expect(entry.tool).toBe("delete_patient");
      expect(entry.verdict).toBe("require-confirmation");
      expect(entry.app).toBe("lakeside-portal");
    }
  });
});

describe("routing", () => {
  it("404s an unknown guard endpoint", async () => {
    const response = await POST(...guardRequest(["nope"], {}));
    expect(response.status).toBe(404);
  });
});

/**
 * The Phase 3 headline, through the real mounted routes and the real seeded
 * patient database: a result goes out tokenized, the agent hands a token back,
 * the gate turns it into a value the portal's own lookup accepts, and an
 * administrator can reveal what is behind a token — with that reveal itself
 * audited.
 */
describe("data controls end to end", () => {
  const patient = () => {
    const summary = searchPatients({ text: "LM-100001" })[0];
    return { ...summary, name: `${summary.firstName} ${summary.lastName}` };
  };

  /** Runs one guarded call and hands back the transformed result. */
  async function guardedCall(
    tool: string,
    args: Record<string, unknown>,
    toolTags: string[],
    result: unknown,
  ) {
    const gate = await payloadOf(
      await POST(...guardRequest(["gate"], { app: APP, tool, args, toolTags })),
    );
    const transform = await payloadOf(
      await POST(...guardRequest(["transform"], { app: APP, tool, callId: gate.callId, result })),
    );
    return { gate, transform };
  }

  it("tokenizes names and MRNs on the way out and leaves clinical data alone", async () => {
    const target = patient();
    const { transform } = await guardedCall(
      "search_patients",
      { condition: "hypertension", limit: 3 },
      ["read", "phi"],
      {
        summary: "1 patient(s) returned of 21 matching.",
        patients: [
          {
            mrn: target.mrn,
            name: target.name,
            dob: target.dob,
            phone: target.phone,
            primaryConditions: target.primaryConditions,
            nextAppointmentAt: target.nextAppointmentAt,
          },
        ],
      },
    );

    const returned = (transform.result as { patients: Record<string, string>[] }).patients[0];
    expect(returned.mrn).toMatch(/^tok_mrn_[0-9a-f]{8}$/);
    expect(returned.name).toMatch(/^tok_name_[0-9a-f]{8}$/);
    expect(returned.dob).toMatch(/^(age \d{2}-\d{2}|age 90\+|under 10)$/);
    // docs/05: conditions and appointment dates stay in the clear.
    expect(returned.primaryConditions).toEqual(target.primaryConditions);
    expect(returned.nextAppointmentAt).toBe(target.nextAppointmentAt);
    expect(transform.classesFound).toContain("name");
    expect(transform.classesFound).toContain("mrn");
  });

  it("resolves a name token back into a full name the portal can look up", async () => {
    const target = patient();
    const { transform } = await guardedCall("search_patients", {}, ["read", "phi"], {
      patients: [{ mrn: target.mrn, name: target.name }],
    });
    const tokens = (transform.result as { patients: Record<string, string>[] }).patients[0];

    const gate = await payloadOf(
      await POST(
        ...guardRequest(["gate"], {
          app: APP,
          tool: "get_patient",
          args: { patient: tokens.name },
          toolTags: ["read", "phi"],
        }),
      ),
    );

    expect(gate.args).toEqual({ patient: target.name });
    // And that is an identifier the host app's own lookup accepts.
    expect(getPatient(target.name)?.mrn).toBe(target.mrn);
  });

  it("detokenizes a name mentioned inside a note the agent is writing", async () => {
    const target = patient();
    const { transform } = await guardedCall("search_patients", {}, ["read", "phi"], {
      patients: [{ mrn: target.mrn, name: target.name }],
    });
    const tokens = (transform.result as { patients: Record<string, string>[] }).patients[0];

    const gate = await payloadOf(
      await POST(
        ...guardRequest(["gate"], {
          app: APP,
          tool: "add_visit_note",
          args: {
            patient: tokens.mrn,
            note: `Emergency contact confirmed for ${tokens.name}.`,
          },
          toolTags: ["write", "phi"],
        }),
      ),
    );

    expect(gate.args).toEqual({
      patient: target.mrn,
      note: `Emergency contact confirmed for ${target.name}.`,
    });
  });

  it("finds a seeded patient's name in free text through the host's dictionary", async () => {
    const target = patient();
    const { transform } = await guardedCall(
      "get_patient",
      { patient: target.mrn },
      ["read", "phi"],
      {
        notes: [{ author: "Dr. Alicia Reyes", body: `${target.name} called about a refill.` }],
      },
    );

    const body = (transform.result as { notes: { body: string }[] }).notes[0].body;
    expect(body).toMatch(/^tok_name_[0-9a-f]{8} called about a refill\.$/);
    expect(transform.classesFound).toContain("free_text_phi");
  });

  it("reveals a token to an administrator and records the reveal", async () => {
    const target = patient();
    const { transform } = await guardedCall("search_patients", {}, ["read", "phi"], {
      patients: [{ mrn: target.mrn }],
    });
    const token = (transform.result as { patients: { mrn: string }[] }).patients[0].mrn;
    const adminToken = resolveGuardSecrets().adminToken;

    const [request, context] = guardRequest(["tokens", "reveal"], { token });
    const unauthorized = await POST(request, context);
    expect(unauthorized.status).toBe(401);

    const authorized = await POST(
      new Request(`${BASE}/tokens/reveal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ version: WIRE_VERSION, payload: { token } }),
      }),
      { params: Promise.resolve({ route: ["tokens", "reveal"] }) },
    );

    expect(authorized.status).toBe(200);
    expect(await payloadOf(authorized)).toEqual({
      token,
      dataClass: "mrn",
      value: target.mrn,
    });

    const logs = await GET(
      new Request(`${BASE}/logs?app=webmcp-guard&tool=console_reveal`, {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
      { params: Promise.resolve({ route: ["logs"] }) },
    );
    const page = (await payloadOf(logs)) as unknown as {
      entries: { tool: string; message?: string }[];
    };
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries[0].tool).toBe("console_reveal");
    expect(page.entries[0].message).toContain(token);
  });
});
