import type { PostureSnapshot } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import { agentInfoFromPosture, pickBrand, postureBrands } from "./posture";

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

describe("postureBrands", () => {
  it("reports every real Client-Hints brand, GREASE excluded", () => {
    expect(postureBrands(posture)).toEqual([
      { brand: "Chromium", version: "149" },
      { brand: "Google Chrome", version: "149" },
    ]);
  });

  it("derives brands from the UA string when Client Hints are absent", () => {
    expect(
      postureBrands({
        isSecureContext: true,
        timestamp: posture.timestamp,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "HeadlessChrome/151.0.0.0 Safari/537.36",
      }),
    ).toEqual([
      { brand: "HeadlessChrome", version: "151" },
      { brand: "Chromium", version: "151" },
    ]);
  });

  it("does not second-guess Client Hints with the UA string", () => {
    expect(
      postureBrands({
        ...posture,
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
      }).map((entry) => entry.version),
    ).toEqual(["149", "149"]);
  });

  it("falls back to the UA when every reported brand was GREASE", () => {
    expect(
      postureBrands({
        isSecureContext: true,
        timestamp: posture.timestamp,
        brands: [{ brand: "Not.A/Brand", version: "24" }],
        userAgent: "Mozilla/5.0 (X11; Linux) Firefox/142.0",
      }),
    ).toEqual([{ brand: "Firefox", version: "142" }]);
  });

  it("reports nothing when there is nothing to report", () => {
    expect(postureBrands({ isSecureContext: false, timestamp: posture.timestamp })).toEqual([]);
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
