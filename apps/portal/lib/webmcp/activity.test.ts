import type { GuardEvent } from "@webmcp-guard/sdk";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_FOOTER,
  EMPTY_ACTIVITY_MESSAGE,
  badgeLabel,
  badgeTone,
  eventDetail,
  eventKey,
  formatEventTime,
  newestFirst,
  stageDescription,
} from "./activity";

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    type: "gate",
    tool: "search_patients",
    at: "2026-08-29T16:24:31.000Z",
    ...overrides,
  };
}

describe("badge", () => {
  it("shows the verdict once the gate has spoken", () => {
    expect(badgeLabel(event({ type: "gate", verdict: "allow" }))).toBe("allow");
    expect(badgeLabel(event({ type: "gate", verdict: "deny" }))).toBe("deny");
  });

  it("falls back to the stage when there is no verdict", () => {
    expect(badgeLabel(event({ type: "gate" }))).toBe("gate");
    expect(badgeLabel(event({ type: "error" }))).toBe("error");
    expect(badgeLabel(event({ type: "executed", verdict: "allow" }))).toBe("executed");
  });

  it("colours the pipeline the way docs/05 needs it to read", () => {
    expect(badgeTone(event({ type: "gate", verdict: "allow" }))).toBe("ok");
    expect(badgeTone(event({ type: "transformed", verdict: "allow" }))).toBe("ok");
    expect(badgeTone(event({ type: "executed", verdict: "allow" }))).toBe("neutral");
    expect(badgeTone(event({ type: "gate" }))).toBe("danger");
    expect(badgeTone(event({ type: "gate", verdict: "deny" }))).toBe("danger");
    expect(badgeTone(event({ type: "blocked", verdict: "deny" }))).toBe("danger");
    expect(badgeTone(event({ type: "error" }))).toBe("danger");
  });
});

describe("detail line", () => {
  it("prefers what the guard reported", () => {
    const detail = "Deleting patient records from an agent is blocked by organization policy.";
    expect(eventDetail(event({ type: "blocked", detail }))).toBe(detail);
  });

  it("describes the stage when the guard said nothing", () => {
    expect(eventDetail(event({ type: "executed" }))).toBe("Ran in the page.");
    expect(eventDetail(event({ type: "gate", verdict: "allow" }))).toContain("cleared");
    expect(eventDetail(event({ type: "gate", verdict: "deny" }))).toContain("stopped");
    expect(eventDetail(event({ type: "blocked", detail: "   " }))).toBe(
      stageDescription(event({ type: "blocked" })),
    );
  });
});

describe("ordering and keys", () => {
  it("renders newest first without mutating the source", () => {
    const events = [event({ tool: "a" }), event({ tool: "b" }), event({ tool: "c" })];
    expect(newestFirst(events).map((e) => e.tool)).toEqual(["c", "b", "a"]);
    expect(events.map((e) => e.tool)).toEqual(["a", "b", "c"]);
  });

  it("keys two identical events apart", () => {
    const same = event({ type: "executed", callId: "call-1" });
    expect(eventKey(same, 0)).not.toBe(eventKey(same, 1));
  });
});

describe("formatEventTime", () => {
  it("renders local wall-clock time", () => {
    const at = new Date(2026, 7, 29, 16, 24, 31).toISOString();
    expect(formatEventTime(at)).toBe("16:24:31");
  });

  it("pads single digits", () => {
    const at = new Date(2026, 7, 29, 4, 5, 6).toISOString();
    expect(formatEventTime(at)).toBe("04:05:06");
  });

  it("never throws on a malformed timestamp", () => {
    expect(formatEventTime("not-a-date")).toBe("--:--:--");
  });
});

describe("copy", () => {
  it("says what docs/05 asks it to say", () => {
    expect(EMPTY_ACTIVITY_MESSAGE).toBe(
      "No agent activity yet — tools are registered and waiting.",
    );
    expect(ACTIVITY_FOOTER).toBe("guarded by WebMCP Guard");
  });
});
