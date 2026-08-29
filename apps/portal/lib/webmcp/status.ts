import { GUARD_ENDPOINT } from "./guard";
import type { WebMcpSurface } from "./register";

/**
 * A one-value store for the header's WebMCP status chip.
 *
 * `<WebMcpTools />` writes it after registration; `<WebMcpStatusChip />` reads it
 * through `useSyncExternalStore`. A store rather than context because the two
 * components sit in different parts of the layout tree and the chip must also
 * render on the server (where the answer is always "unknown yet").
 */

export interface WebMcpStatus {
  surface: WebMcpSurface;
  toolCount: number;
  /** False until the first registration attempt has finished. */
  resolved: boolean;
}

/** Frozen so `useSyncExternalStore`'s server snapshot keeps a stable identity. */
export const INITIAL_WEBMCP_STATUS: WebMcpStatus = Object.freeze({
  surface: "unavailable" as WebMcpSurface,
  toolCount: 0,
  resolved: false,
});

/** Window event fired whenever a WebMCP tool changes portal data. */
export const PORTAL_DATA_CHANGED_EVENT = "lakeside:data-changed";

let current: WebMcpStatus = INITIAL_WEBMCP_STATUS;
const listeners = new Set<() => void>();

export function getWebMcpStatus(): WebMcpStatus {
  return current;
}

export function getServerWebMcpStatus(): WebMcpStatus {
  return INITIAL_WEBMCP_STATUS;
}

export function setWebMcpStatus(next: WebMcpStatus): void {
  if (
    next.surface === current.surface &&
    next.toolCount === current.toolCount &&
    next.resolved === current.resolved
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeWebMcpStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Chip tooltip. Says both halves out loud — the tools are registered on a real
 * WebMCP surface, and every call they make goes through the guard mounted at
 * `/api/guard` — because that sentence is the product in one line.
 */
export function guardedToolsTooltip(status: WebMcpStatus): string {
  const noun = status.toolCount === 1 ? "tool" : "tools";
  return (
    `${status.toolCount} ${noun} guarded via ${GUARD_ENDPOINT}. ` +
    `Registered on ${status.surface}.modelContext; every agent call is gated, logged and ` +
    "transformed by WebMCP Guard before the model sees a result."
  );
}

/** Test seam: returns the store to its pre-registration state. */
export function resetWebMcpStatus(): void {
  current = INITIAL_WEBMCP_STATUS;
  listeners.clear();
}
