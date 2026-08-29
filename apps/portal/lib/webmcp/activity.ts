import type { GuardEvent } from "@webmcp-guard/sdk";

/**
 * Presentation logic for the Agent Activity drawer (docs/05: "the single most
 * demo-friendly UI element in the project").
 *
 * Kept out of the component so it can be unit tested — the portal's test
 * environment is plain node, with no DOM to render into.
 *
 * One row per pipeline event, so a viewer watches a call move through the guard
 * rather than seeing a single opaque "done": `allow → executed → transformed`
 * for a permitted read, `deny → blocked` for the delete the policy stops, and
 * `require-confirmation → declined → blocked` when the person at the keyboard
 * says no.
 */

/** Green = the agent got something, red = it did not, slate = in flight. */
export type ActivityTone = "ok" | "danger" | "neutral";

/** Newest first — the drawer shows the most recent event at the top. */
export function newestFirst(events: readonly GuardEvent[]): GuardEvent[] {
  return [...events].reverse();
}

/**
 * The badge text: the policy verdict once the gate has spoken, the pipeline
 * stage otherwise. `gate` only appears when a verdict never arrived.
 */
export function badgeLabel(event: GuardEvent): string {
  if (event.type === "gate") return event.verdict ?? "gate";
  // "approved" / "declined" reads better on the badge than "confirmation", and
  // the human decision is the whole point of that row.
  if (event.type === "confirmation") return event.decision ?? "confirmation";
  return event.type;
}

export function badgeTone(event: GuardEvent): ActivityTone {
  if (event.type === "blocked" || event.type === "error") return "danger";
  // A gate that did not say "allow" is the deny beat; never show it as routine.
  if (event.type === "gate") return event.verdict === "allow" ? "ok" : "danger";
  if (event.type === "confirmation") {
    if (event.decision === "approved") return "ok";
    return event.decision === "declined" ? "danger" : "neutral";
  }
  if (event.type === "transformed") return "ok";
  return "neutral";
}

/** Plain-English stage line, shown under the tool name when there is no detail. */
export function stageDescription(event: GuardEvent): string {
  switch (event.type) {
    case "gate":
      return event.verdict === "allow"
        ? "Policy gate cleared this call."
        : "Policy gate stopped this call.";
    case "confirmation":
      return event.decision === "approved"
        ? "The person at the keyboard approved this call."
        : event.decision === "declined"
          ? "The person at the keyboard declined this call."
          : "Waiting on the person at the keyboard.";
    case "blocked":
      return "Blocked before the tool ran.";
    case "executed":
      return "Ran in the page.";
    case "transformed":
      return "Result transformed and returned to the agent.";
    case "error":
      return "The guard could not complete this call.";
    default:
      return "";
  }
}

/** The detail line: whatever the guard reported, else the stage description. */
export function eventDetail(event: GuardEvent): string {
  return event.detail?.trim() || stageDescription(event);
}

/** `16:24:31` in the viewer's own timezone. Never throws on a bad timestamp. */
export function formatEventTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A stable key for React. Events carry no id of their own, and two events of
 * the same stage can share a call id (a retried transform) — the index keeps
 * the key unique without reordering anything.
 */
export function eventKey(event: GuardEvent, index: number): string {
  return `${event.at}:${event.type}:${event.callId ?? event.tool}:${index}`;
}

/** Empty state, verbatim from the task brief / docs/05. */
export const EMPTY_ACTIVITY_MESSAGE = "No agent activity yet — tools are registered and waiting.";

/** Footer line: the drawer should say what is doing the guarding. */
export const ACTIVITY_FOOTER = "guarded by WebMCP Guard";
