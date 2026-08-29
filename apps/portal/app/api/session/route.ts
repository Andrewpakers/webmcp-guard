import { jsonError, jsonOk, readJsonBody, stringField } from "@/lib/http";
import { findPersona, PERSONAS, personaLabel } from "@/lib/session/personas";
import { personaCookieHeaders, readPortalSession } from "@/lib/session/cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/api/session` — the portal's mock login (`docs/05` § "Human UI", Phase 6).
 *
 * `POST { "persona": "sam-levin" }` signs a session cookie for that persona and
 * hands back two `Set-Cookie` headers: the signed httpOnly one the guard's
 * `resolveSession` verifies, and an unsigned display copy the page reads for the
 * SDK's `getSessionContext`.
 *
 * There is no password and no lock: any visitor can become any of the three
 * personas, on purpose. This is a demo of *role-scoped policy*, not of
 * authentication (`docs/01`: real SSO/OIDC is out of scope). What the signature
 * buys is that the role reaching the policy engine is one this server minted,
 * rather than a string the page made up — which is the property the Phase 6
 * story actually rests on.
 */

/** `https` behind Render's proxy shows up in the forwarded header, not the URL. */
function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) {
    return forwarded
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("https");
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function personaPayload(id: string) {
  const persona = findPersona(id);
  return persona === undefined ? null : { ...persona, label: personaLabel(persona) };
}

/** The active persona and the full cast — handy for tests and for the e2e harness. */
export function GET(request: Request): Response {
  const { persona, source } = readPortalSession(request);
  return jsonOk({
    persona: personaPayload(persona.id),
    /** `cookie` when a signed cookie named this persona, `default` otherwise. */
    source,
    personas: PERSONAS.map((entry) => personaPayload(entry.id)),
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null)
    return jsonError(400, 'Expected a JSON object body such as {"persona":"sam-levin"}.');

  const requested = stringField(body, "persona");
  if (requested === undefined) {
    return jsonError(400, "Missing required field 'persona'.");
  }

  const persona = findPersona(requested);
  if (persona === undefined) {
    return jsonError(
      404,
      `Unknown persona '${requested}'. Choose one of: ${PERSONAS.map((entry) => entry.id).join(", ")}.`,
    );
  }

  const response = jsonOk({ persona: personaPayload(persona.id), source: "cookie" });
  for (const cookie of personaCookieHeaders(persona, { secure: isSecureRequest(request) })) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
