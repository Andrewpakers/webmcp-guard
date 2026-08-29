import { describe, expect, it } from "vitest";

import {
  REVEAL_LOG_APP,
  REVEAL_LOG_TOOL,
  RevealLogResponseSchema,
  RevealRequestSchema,
  RevealTokenResponseSchema,
} from "./reveal";

describe("RevealRequestSchema", () => {
  it("accepts either form, and both together", () => {
    expect(RevealRequestSchema.safeParse({ token: "tok_ssn_1a2b3c4d" }).success).toBe(true);
    expect(RevealRequestSchema.safeParse({ logId: "call-1" }).success).toBe(true);
    expect(
      RevealRequestSchema.safeParse({ token: "tok_ssn_1a2b3c4d", logId: "call-1" }).success,
    ).toBe(true);
  });

  it("refuses an empty request", () => {
    const parsed = RevealRequestSchema.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toContain("token");
  });

  it("refuses unknown fields and oversized values", () => {
    expect(RevealRequestSchema.safeParse({ token: "t", reveal: "everything" }).success).toBe(false);
    expect(RevealRequestSchema.safeParse({ token: "x".repeat(129) }).success).toBe(false);
  });
});

describe("reveal responses", () => {
  it("carries the token, its class and the original value", () => {
    expect(
      RevealTokenResponseSchema.parse({
        token: "tok_ssn_1a2b3c4d",
        dataClass: "ssn",
        value: "927-78-1337",
      }),
    ).toEqual({ token: "tok_ssn_1a2b3c4d", dataClass: "ssn", value: "927-78-1337" });
  });

  it("acknowledges a payload reveal without echoing anything back", () => {
    expect(RevealLogResponseSchema.parse({ logId: "call-1", acknowledged: true })).toEqual({
      logId: "call-1",
      acknowledged: true,
    });
    expect(
      RevealLogResponseSchema.safeParse({ logId: "call-1", acknowledged: false }).success,
    ).toBe(false);
  });
});

describe("audit identity", () => {
  it("files reveals under the guard itself, not the host app", () => {
    expect(REVEAL_LOG_APP).toBe("webmcp-guard");
    expect(REVEAL_LOG_TOOL).toBe("console_reveal");
  });
});
