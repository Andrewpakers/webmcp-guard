import { PostureSnapshotSchema } from "@webmcp-guard/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_UA_MARKERS, collectPostureSnapshot, guessAgentId } from "./posture";
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

  /**
   * The UA fallback (`docs/04` behavior 5). Client Hints are Chromium-only and
   * secure-context-only, so without this a `browser` posture rule would simply
   * never fire for Safari, Firefox, or anything on plain http.
   */
  describe("UA-string fallback", () => {
    it("fills brands from the UA when Client Hints are missing", () => {
      defineGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      });

      const snapshot = collectPostureSnapshot();
      expect(PostureSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.brands).toEqual([{ brand: "Safari", version: "18" }]);
    });

    it("reports Chromium the way Client Hints would have", () => {
      defineGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/151.0.0.0 Safari/537.36",
      });

      expect(collectPostureSnapshot().brands).toEqual([
        { brand: "Google Chrome", version: "151" },
        { brand: "Chromium", version: "151" },
      ]);
    });

    it("never overrides real Client Hints", () => {
      defineGlobal("navigator", {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36",
        userAgentData: { brands: [{ brand: "Chromium", version: "151" }] },
      });

      expect(collectPostureSnapshot().brands).toEqual([{ brand: "Chromium", version: "151" }]);
    });

    it("omits brands entirely when the UA says nothing recognisable", () => {
      defineGlobal("navigator", { userAgent: "curl/8.5.0" });
      expect(collectPostureSnapshot()).not.toHaveProperty("brands");
    });
  });

  /**
   * The best-effort agent guess. Advisory only, and spoofable in one line — a
   * rule written against an agent id is routing, never authorization.
   */
  describe("agent id markers", () => {
    it("recognises ChatGPT's in-app browser", () => {
      defineGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1 ChatGPT/1.2026.8",
      });
      expect(collectPostureSnapshot().agentId).toBe("chatgpt-inapp");
    });

    it("prefers the more specific Atlas marker over the general one", () => {
      defineGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 ChatGPT-Atlas/1.0",
      });
      expect(collectPostureSnapshot().agentId).toBe("chatgpt-atlas");
      // The order of the marker list is what makes that true.
      expect(AGENT_UA_MARKERS.map((entry) => entry.id)).toEqual(["chatgpt-atlas", "chatgpt-inapp"]);
    });

    it("matches case-insensitively and reads Client-Hints brands too", () => {
      expect(guessAgentId("… chatgpt/1.0 …", undefined)).toBe("chatgpt-inapp");
      expect(guessAgentId(undefined, [{ brand: "ChatGPT" }, { brand: "Chromium" }])).toBe(
        "chatgpt-inapp",
      );
    });

    it("omits agentId rather than guessing when nothing matches", () => {
      defineGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "HeadlessChrome/151.0.0.0 Safari/537.36",
      });

      const snapshot = collectPostureSnapshot();
      expect(snapshot).not.toHaveProperty("agentId");
      expect(guessAgentId(undefined, undefined)).toBeUndefined();
      expect(guessAgentId("", [])).toBeUndefined();
    });
  });

  it("stamps a fresh timestamp on every snapshot", async () => {
    const first = collectPostureSnapshot().timestamp;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = collectPostureSnapshot().timestamp;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
  });
});
