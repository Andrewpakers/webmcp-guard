import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index";

describe("@webmcp-guard/server", () => {
  it("is wired into the workspace test run", () => {
    expect(PACKAGE_NAME).toBe("@webmcp-guard/server");
  });
});
