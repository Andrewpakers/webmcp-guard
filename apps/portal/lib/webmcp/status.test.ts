import { afterEach, describe, expect, it, vi } from "vitest";

import { GUARD_ENDPOINT } from "./guard";
import {
  INITIAL_WEBMCP_STATUS,
  PORTAL_DATA_CHANGED_EVENT,
  getServerWebMcpStatus,
  getWebMcpStatus,
  guardedToolsTooltip,
  resetWebMcpStatus,
  setWebMcpStatus,
  subscribeWebMcpStatus,
} from "./status";

afterEach(() => resetWebMcpStatus());

describe("the status store", () => {
  it("starts unresolved so the chip can render on the server", () => {
    expect(getWebMcpStatus()).toEqual({ surface: "unavailable", toolCount: 0, resolved: false });
    // `useSyncExternalStore` compares snapshots by identity: the server snapshot
    // must be the same frozen object every time or React loops forever.
    expect(getServerWebMcpStatus()).toBe(INITIAL_WEBMCP_STATUS);
    expect(getServerWebMcpStatus()).toBe(getServerWebMcpStatus());
  });

  it("notifies subscribers when the status changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebMcpStatus(listener);

    setWebMcpStatus({ surface: "document", toolCount: 7, resolved: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getWebMcpStatus()).toEqual({ surface: "document", toolCount: 7, resolved: true });

    unsubscribe();
    setWebMcpStatus({ surface: "document", toolCount: 6, resolved: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores an identical status, so the chip does not re-render for nothing", () => {
    const listener = vi.fn();
    subscribeWebMcpStatus(listener);

    setWebMcpStatus({ surface: "document", toolCount: 7, resolved: true });
    setWebMcpStatus({ surface: "document", toolCount: 7, resolved: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("names the event the human UI listens for", () => {
    expect(PORTAL_DATA_CHANGED_EVENT).toBe("lakeside:data-changed");
  });
});

describe("guardedToolsTooltip", () => {
  it("says how many tools are guarded and where the guard is mounted", () => {
    const tooltip = guardedToolsTooltip({ surface: "document", toolCount: 7, resolved: true });

    expect(tooltip).toContain(`7 tools guarded via ${GUARD_ENDPOINT}`);
    expect(tooltip).toContain("document.modelContext");
  });

  it("gets the singular right", () => {
    expect(guardedToolsTooltip({ surface: "navigator", toolCount: 1, resolved: true })).toContain(
      "1 tool guarded",
    );
  });
});
