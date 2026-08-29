import { describe, expect, it } from "vitest";

import { SITE, headline } from "./site";

describe("portal site identity", () => {
  it("renders the landing headline", () => {
    expect(headline()).toBe("Lakeside Medical — coming online");
  });

  it("uses the app id the policy engine scopes on", () => {
    expect(SITE.id).toBe("lakeside-portal");
  });

  it("always carries a synthetic-data notice", () => {
    expect(SITE.demoNotice).toMatch(/synthetic/i);
  });
});
