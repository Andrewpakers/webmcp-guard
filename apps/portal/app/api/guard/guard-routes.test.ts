import { WIRE_VERSION } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

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

  it("denies delete_patient with the seeded TEMP rule and explains why", async () => {
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
    expect(payload.verdict).toBe("deny");
    expect(payload.ruleIds).toContain("delete-patient-deny-temp");
    // The message is what the agent reads: prose, and a route to the human.
    expect(String(payload.message)).toContain("blocked by organization policy");
    // A denied call never gets args to execute with.
    expect(payload.args).toBeUndefined();
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

  it("shows the denied call to an admin", async () => {
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
      expect(entry.verdict).toBe("deny");
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
