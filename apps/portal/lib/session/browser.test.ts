import { describe, expect, it } from "vitest";

import { PORTAL_PERSONA_COOKIE } from "./cookie-names";
import {
  SESSION_BOOTSTRAP_ATTRIBUTES,
  readBrowserPersona,
  readBrowserSessionContext,
} from "./browser";
import { DEFAULT_PERSONA } from "./personas";

/**
 * A `Document` stand-in. The portal's vitest project runs in node, and this
 * module only ever touches `document.cookie` and one `<body>` attribute — a
 * two-field fake is a more honest test than a jsdom that could drift.
 */
function fakeDocument(options: { cookie?: string; bootstrap?: string } = {}): Document {
  return {
    cookie: options.cookie ?? "",
    body:
      options.bootstrap === undefined
        ? null
        : {
            getAttribute: (name: string) =>
              name === SESSION_BOOTSTRAP_ATTRIBUTES.userId ? (options.bootstrap as string) : null,
          },
  } as unknown as Document;
}

describe("readBrowserPersona", () => {
  it("prefers the display cookie", () => {
    const doc = fakeDocument({
      cookie: `theme=dark; ${PORTAL_PERSONA_COOKIE}=sam-levin`,
      bootstrap: "dr-reyes",
    });
    expect(readBrowserPersona(doc).role).toBe("billing");
  });

  it("falls back to the layout's body bootstrap", () => {
    expect(readBrowserPersona(fakeDocument({ bootstrap: "nurse-okafor" })).role).toBe("nursing");
  });

  it("falls back to the default persona when there is nothing to read", () => {
    expect(readBrowserPersona(fakeDocument())).toEqual(DEFAULT_PERSONA);
    expect(readBrowserPersona(undefined)).toEqual(DEFAULT_PERSONA);
  });

  it("ignores a cookie naming a persona that does not exist", () => {
    const doc = fakeDocument({
      cookie: `${PORTAL_PERSONA_COOKIE}=dr-nobody`,
      bootstrap: "sam-levin",
    });
    expect(readBrowserPersona(doc).id).toBe("sam-levin");
  });

  it("reports the { userId, role } shape getSessionContext must return", () => {
    const doc = fakeDocument({ cookie: `${PORTAL_PERSONA_COOKIE}=sam-levin` });
    expect(readBrowserSessionContext(doc)).toEqual({ userId: "sam-levin", role: "billing" });
  });
});
