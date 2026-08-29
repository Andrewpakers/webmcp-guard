import { afterEach, describe, expect, it, vi } from "vitest";

import { REVEAL_FIELD_ENDPOINT, revealPatientField } from "./reveal";

/**
 * The client half of a reveal, driven against a stubbed `fetch`. What matters
 * here is that it asks for exactly one field of one patient and that a refusal
 * surfaces as the message the route wrote, not as a swallowed empty value.
 */

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revealPatientField", () => {
  it("posts the patient and field, and returns the value", async () => {
    const fetchMock = stubFetch(200, { ok: true, field: "ssn", value: "900-01-0001" });

    await expect(revealPatientField("LM-100001", "ssn")).resolves.toBe("900-01-0001");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REVEAL_FIELD_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ patientId: "LM-100001", field: "ssn" });
  });

  it("throws the route's own explanation on a refusal", async () => {
    stubFetch(404, { ok: false, error: "No patient found for 'LM-999999'." });

    await expect(revealPatientField("LM-999999", "ssn")).rejects.toThrow(
      "No patient found for 'LM-999999'.",
    );
  });

  it("throws on a success status with no value, rather than rendering nothing", async () => {
    stubFetch(200, { ok: true });
    await expect(revealPatientField("LM-100001", "dob")).rejects.toThrow("Could not reveal");
  });

  it("survives a non-JSON error body", async () => {
    stubFetch(502, "<html>bad gateway</html>");
    await expect(revealPatientField("LM-100001", "phone")).rejects.toThrow("(502)");
  });
});
