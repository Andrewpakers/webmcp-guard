import { describe, expect, it } from "vitest";

import { SITE, guardApiUrl, headline } from "./site";

describe("console site identity", () => {
  it("renders the landing headline", () => {
    expect(headline()).toBe("WebMCP Guard Console");
  });

  it("has a stable app id", () => {
    expect(SITE.id).toBe("webmcp-guard-console");
  });

  it("falls back to the local portal guard API", () => {
    expect(guardApiUrl()).toBe("http://localhost:3000/api/guard");
  });
});
