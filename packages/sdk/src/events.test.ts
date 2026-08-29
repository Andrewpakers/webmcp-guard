import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardEventHub, guardEvent } from "./events";
import { GUARD_EVENT_BUFFER_SIZE, type GuardEvent } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GuardEventHub", () => {
  it("stamps every event with an ISO timestamp", () => {
    const hub = new GuardEventHub();
    const event = hub.emit(guardEvent("gate", "search_patients", { callId: "c1" }));

    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    expect(event).toMatchObject({ type: "gate", tool: "search_patients", callId: "c1" });
  });

  it("delivers to every subscriber and stops after unsubscribe", () => {
    const hub = new GuardEventHub();
    const a: GuardEvent[] = [];
    const b: GuardEvent[] = [];
    const unsubscribeA = hub.subscribe((event) => a.push(event));
    hub.subscribe((event) => b.push(event));

    hub.emit(guardEvent("executed", "t"));
    unsubscribeA();
    hub.emit(guardEvent("transformed", "t"));

    expect(a.map((event) => event.type)).toEqual(["executed"]);
    expect(b.map((event) => event.type)).toEqual(["executed", "transformed"]);
  });

  it("isolates listeners from each other's failures", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = new GuardEventHub();
    const seen: GuardEvent[] = [];

    hub.subscribe(() => {
      throw new Error("drawer blew up");
    });
    hub.subscribe((event) => seen.push(event));

    expect(() => hub.emit(guardEvent("error", "t"))).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
  });

  it("tolerates a listener that unsubscribes during delivery", () => {
    const hub = new GuardEventHub();
    const seen: GuardEvent[] = [];
    const unsubscribe = hub.subscribe(() => unsubscribe());
    hub.subscribe((event) => seen.push(event));

    hub.emit(guardEvent("gate", "t"));
    hub.emit(guardEvent("gate", "t"));

    expect(seen).toHaveLength(2);
  });

  it("keeps only the last 50 events, oldest first", () => {
    const hub = new GuardEventHub();
    for (let index = 0; index < 60; index += 1) {
      hub.emit(guardEvent("gate", `tool_${index}`));
    }

    const recent = hub.recent();
    expect(GUARD_EVENT_BUFFER_SIZE).toBe(50);
    expect(recent).toHaveLength(50);
    expect(recent[0].tool).toBe("tool_10");
    expect(recent.at(-1)?.tool).toBe("tool_59");
  });

  it("hands out a copy of its history", () => {
    const hub = new GuardEventHub();
    hub.emit(guardEvent("gate", "t"));

    const first = hub.recent();
    first.push({ type: "error", tool: "injected", at: "now" });

    expect(hub.recent()).toHaveLength(1);
  });

  it("honours a custom capacity", () => {
    const hub = new GuardEventHub(2);
    hub.emit(guardEvent("gate", "a"));
    hub.emit(guardEvent("gate", "b"));
    hub.emit(guardEvent("gate", "c"));

    expect(hub.recent().map((event) => event.tool)).toEqual(["b", "c"]);
  });
});
