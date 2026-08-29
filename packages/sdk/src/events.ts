import {
  GUARD_EVENT_BUFFER_SIZE,
  type GuardEvent,
  type GuardEventListener,
  type GuardEventType,
} from "./types";

/**
 * The event stream behind the portal's Agent Activity drawer.
 *
 * Two requirements shape it: a drawer mounted *after* an agent has already been
 * working must still show what happened (hence the ring buffer), and a broken
 * listener must never take down a tool call (hence the try/catch around every
 * notification — a UI bug is not a reason to fail an agent's request).
 */
export class GuardEventHub {
  private readonly listeners = new Set<GuardEventListener>();
  private readonly buffer: GuardEvent[] = [];

  constructor(private readonly capacity: number = GUARD_EVENT_BUFFER_SIZE) {}

  /** Stamps `at` and fans the event out to every listener. */
  emit(event: Omit<GuardEvent, "at"> & { at?: string }): GuardEvent {
    const stamped: GuardEvent = { ...event, at: event.at ?? new Date().toISOString() };

    this.buffer.push(stamped);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(stamped);
      } catch (error) {
        console.error("[WebMCP Guard] a guard event listener threw:", error);
      }
    }
    return stamped;
  }

  subscribe(listener: GuardEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Oldest first, newest last. A copy — callers cannot mutate history. */
  recent(): GuardEvent[] {
    return [...this.buffer];
  }
}

/** Convenience for the pipeline: build an event without repeating the stamp. */
export function guardEvent(
  type: GuardEventType,
  tool: string,
  extra: Partial<Omit<GuardEvent, "type" | "tool" | "at">> = {},
): Omit<GuardEvent, "at"> {
  return { type, tool, ...extra };
}
