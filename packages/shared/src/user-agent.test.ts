import { describe, expect, it } from "vitest";

import { brandMajorVersion, parseUserAgentBrands, sameBrand } from "./user-agent";

/**
 * The UA fallback exists so a `browser` posture rule means the same thing for a
 * client that reports Client Hints and one that does not. These are real UA
 * strings, not invented ones — the parser is only worth anything if it agrees
 * with what browsers actually send.
 */

const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36";
const HEADLESS =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "HeadlessChrome/151.0.0.0 Safari/537.36";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36 Edg/151.0.2903.51";
const OPERA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36 OPR/135.0.0.0";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";

describe("parseUserAgentBrands", () => {
  it("reports Chrome the way Client Hints would: the product and the engine", () => {
    expect(parseUserAgentBrands(CHROME)).toEqual([
      { brand: "Google Chrome", version: "151" },
      { brand: "Chromium", version: "151" },
    ]);
  });

  it("recognises headless Chromium, which is what the e2e harness runs", () => {
    expect(parseUserAgentBrands(HEADLESS)).toEqual([
      { brand: "HeadlessChrome", version: "151" },
      { brand: "Chromium", version: "151" },
    ]);
  });

  it("prefers the derivative over the Chrome token it also carries", () => {
    expect(parseUserAgentBrands(EDGE)[0]).toEqual({ brand: "Microsoft Edge", version: "151" });
    expect(parseUserAgentBrands(OPERA)[0]).toEqual({ brand: "Opera", version: "135" });
  });

  it("handles the non-Chromium browsers", () => {
    expect(parseUserAgentBrands(FIREFOX)).toEqual([{ brand: "Firefox", version: "142" }]);
    expect(parseUserAgentBrands(SAFARI)).toEqual([{ brand: "Safari", version: "18" }]);
    expect(parseUserAgentBrands(IOS_SAFARI)).toEqual([{ brand: "Safari", version: "18" }]);
  });

  it("does not mistake Chrome's Safari token for Safari", () => {
    expect(parseUserAgentBrands(CHROME).map((entry) => entry.brand)).not.toContain("Safari");
  });

  it("returns nothing rather than guessing", () => {
    expect(parseUserAgentBrands("")).toEqual([]);
    expect(parseUserAgentBrands("curl/8.5.0")).toEqual([]);
    expect(parseUserAgentBrands(undefined)).toEqual([]);
    expect(parseUserAgentBrands(42)).toEqual([]);
    expect(parseUserAgentBrands(null)).toEqual([]);
  });

  it("bounds the work it will do on a hostile UA string", () => {
    expect(parseUserAgentBrands(`${"a".repeat(50_000)} Chrome/151.0.0.0`)).toEqual([]);
  });
});

describe("brandMajorVersion", () => {
  it("reads the leading integer", () => {
    expect(brandMajorVersion("151")).toBe(151);
    expect(brandMajorVersion("151.0.7049.42")).toBe(151);
    expect(brandMajorVersion(" 8")).toBe(8);
  });

  it("returns null for anything it cannot read, instead of guessing zero", () => {
    expect(brandMajorVersion("stable")).toBeNull();
    expect(brandMajorVersion("")).toBeNull();
    expect(brandMajorVersion("v151")).toBeNull();
    expect(brandMajorVersion(undefined)).toBeNull();
    expect(brandMajorVersion(151)).toBeNull();
  });
});

describe("sameBrand", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(sameBrand("Chromium", "chromium")).toBe(true);
    expect(sameBrand(" Google Chrome ", "google chrome")).toBe(true);
  });

  it("is exact, never a substring match", () => {
    expect(sameBrand("Chrome", "Chromium")).toBe(false);
    expect(sameBrand("Chrome", "Google Chrome")).toBe(false);
  });
});
