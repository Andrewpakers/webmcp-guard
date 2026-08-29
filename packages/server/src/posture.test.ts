import type { PostureSnapshot } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { agentInfoFromPosture, pickBrand } from "./posture";

const posture: PostureSnapshot = {
  brands: [
    { brand: "Not/A)Brand", version: "8" },
    { brand: "Chromium", version: "149" },
    { brand: "Google Chrome", version: "149" },
  ],
  platform: "macOS",
  mobile: false,
  userAgent: "Mozilla/5.0 (Macintosh)",
  isSecureContext: true,
  viewport: { width: 1440, height: 900 },
  agentId: "chatgpt-atlas",
  timestamp: "2026-08-29T12:00:00.000Z",
};

describe("pickBrand", () => {
  it("prefers the specific brand over Chromium and skips the GREASE entry", () => {
    expect(pickBrand(posture.brands)).toEqual({ brand: "Google Chrome", version: "149" });
  });

  it("falls back to Chromium when it is the only real brand", () => {
    expect(
      pickBrand([
        { brand: "Not_A Brand", version: "24" },
        { brand: "Chromium", version: "151" },
      ]),
    ).toEqual({ brand: "Chromium", version: "151" });
  });

  it("returns undefined when there is nothing to report", () => {
    expect(pickBrand(undefined)).toBeUndefined();
    expect(pickBrand([])).toBeUndefined();
    expect(pickBrand([{ brand: ";Not A Brand", version: "99" }])).toBeUndefined();
  });
});

describe("agentInfoFromPosture", () => {
  it("returns an empty record when the SDK sent no snapshot", () => {
    expect(agentInfoFromPosture(undefined)).toEqual({});
  });

  it("flattens the snapshot into the log's agent block", () => {
    expect(agentInfoFromPosture(posture)).toEqual({
      agentId: "chatgpt-atlas",
      browserBrand: "Google Chrome",
      browserVersion: "149",
      platform: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh)",
      isSecureContext: true,
    });
  });

  it("keeps absent fields absent rather than inventing them", () => {
    expect(agentInfoFromPosture({ isSecureContext: false, timestamp: posture.timestamp })).toEqual({
      isSecureContext: false,
    });
  });

  it("caps caller-controlled identity strings", () => {
    const info = agentInfoFromPosture({
      ...posture,
      agentId: "a".repeat(200),
      userAgent: "u".repeat(2000),
    });

    expect(info.agentId?.length).toBeLessThanOrEqual(65);
    expect(info.userAgent?.length).toBeLessThanOrEqual(513);
  });
});
