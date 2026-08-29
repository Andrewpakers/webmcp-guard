import { PostureSnapshotSchema } from "@webmcp-guard/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectPostureSnapshot } from "./posture";
import { clearBrowserGlobals, defineGlobal, restoreBrowserGlobals } from "./test-support";

/**
 * The snapshot has one hard requirement: whatever the environment looks like,
 * the result must satisfy `PostureSnapshotSchema`. A snapshot the server
 * rejects would fail every tool call closed — a self-inflicted outage rather
 * than a security control.
 */

beforeEach(() => {
  clearBrowserGlobals();
});

afterEach(() => {
  restoreBrowserGlobals();
});

describe("collectPostureSnapshot", () => {
  it("produces a valid snapshot in a bare environment", () => {
    const snapshot = collectPostureSnapshot();

    expect(PostureSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.isSecureContext).toBe(false);
    expect(snapshot).not.toHaveProperty("viewport");
    expect(snapshot).not.toHaveProperty("userAgent");
  });

  it("collects the full browser picture when it is available", () => {
    defineGlobal("isSecureContext", true);
    defineGlobal("innerWidth", 1440);
    defineGlobal("innerHeight", 900);
    defineGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0",
      userAgentData: {
        brands: [
          { brand: "Chromium", version: "151" },
          { brand: "Not.A/Brand", version: "24" },
        ],
        platform: "macOS",
        mobile: false,
      },
    });

    const snapshot = collectPostureSnapshot();

    expect(PostureSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      isSecureContext: true,
      platform: "macOS",
      mobile: false,
      viewport: { width: 1440, height: 900 },
      brands: [
        { brand: "Chromium", version: "151" },
        { brand: "Not.A/Brand", version: "24" },
      ],
    });
    expect(snapshot.userAgent).toContain("Chrome/151");
  });

  it("defaults isSecureContext to false rather than guessing", () => {
    defineGlobal("isSecureContext", "yes");
    expect(collectPostureSnapshot().isSecureContext).toBe(false);
  });

  it("drops malformed Client Hints instead of sending garbage", () => {
    defineGlobal("navigator", {
      userAgent: 42,
      userAgentData: {
        brands: [{ brand: "Chromium" }, "nonsense", null, { brand: "Edge", version: "151" }],
        platform: 7,
        mobile: "no",
      },
    });

    const snapshot = collectPostureSnapshot();

    expect(PostureSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.brands).toEqual([{ brand: "Edge", version: "151" }]);
    expect(snapshot).not.toHaveProperty("platform");
    expect(snapshot).not.toHaveProperty("mobile");
    expect(snapshot).not.toHaveProperty("userAgent");
  });

  it("omits brands entirely when none survive validation", () => {
    defineGlobal("navigator", { userAgentData: { brands: [{ brand: "Chromium" }] } });
    expect(collectPostureSnapshot()).not.toHaveProperty("brands");
  });

  it("normalizes a fractional or negative viewport to non-negative integers", () => {
    defineGlobal("innerWidth", 1439.6);
    defineGlobal("innerHeight", -10);

    const snapshot = collectPostureSnapshot();

    expect(PostureSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.viewport).toEqual({ width: 1439, height: 0 });
  });

  it("omits the viewport when either dimension is unusable", () => {
    defineGlobal("innerWidth", Number.NaN);
    defineGlobal("innerHeight", 900);
    expect(collectPostureSnapshot()).not.toHaveProperty("viewport");
  });

  it("stamps a fresh timestamp on every snapshot", async () => {
    const first = collectPostureSnapshot().timestamp;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = collectPostureSnapshot().timestamp;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});
