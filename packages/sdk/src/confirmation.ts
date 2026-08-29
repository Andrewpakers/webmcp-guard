import type { JsonObject } from "@webmcp-guard/shared";

import { guardGlobals } from "./webmcp";

/**
 * The in-page confirmation modal (`docs/04` behavior 4, `docs/03` data flow:
 * "for `require-confirmation`, the SDK renders an in-page modal the human must
 * approve").
 *
 * What it is: a way for the *person at the keyboard* to answer a question the
 * agent cannot answer for itself. The one-time id that makes the approval count
 * is issued and spent server-side; this file only produces a decision.
 *
 * What it is not: a security boundary. Page script can click these buttons, and
 * the page's own code already has the data (`docs/03` threat model). The value
 * is that the *model* cannot produce an approval without a real interaction
 * happening in a browser a person is looking at.
 *
 * Written against a deliberately small slice of the DOM — no framework, no
 * innerHTML, no styles outside the elements it creates — so it drops into any
 * host page, including one with no CSS framework at all.
 */

/** What the person decided, or `"cancelled"` when the call went away first. */
export type ConfirmationDecision = "approved" | "declined" | "cancelled";

/** Everything a handler needs to describe the call it is asking about. */
export interface ConfirmationRequest {
  /** App id the guard is scoped to. */
  app: string;
  tool: string;
  /** The policy's own explanation, as the server wrote it. */
  message: string;
  /** Exactly the arguments the approval will be bound to. */
  args: JsonObject;
  /** Server-issued id of the gate call that asked. */
  callId: string;
  /** The one-time id that will be spent if this is approved. */
  confirmationId: string;
  /** Aborted when the agent or the browser cancels the call. */
  signal?: AbortSignal;
}

/**
 * Replaceable approval UI. A host that has its own dialog system passes one to
 * `createGuard({ confirmationHandler })`; the portal keeps the default.
 *
 * A handler must resolve — never reject — and should resolve `"cancelled"` when
 * `request.signal` aborts. Anything it throws is treated as a decline, because
 * an approval flow that failed did not produce an approval.
 */
export type ConfirmationHandler = (
  request: ConfirmationRequest,
) => ConfirmationDecision | Promise<ConfirmationDecision>;

/* ------------------------------------------------------------ test seams -- */

/** `data-testid` values, so the e2e harness can drive the modal over CDP. */
export const CONFIRMATION_TEST_IDS = {
  overlay: "webmcp-guard-confirmation",
  tool: "webmcp-guard-confirmation-tool",
  message: "webmcp-guard-confirmation-message",
  args: "webmcp-guard-confirmation-args",
  approve: "webmcp-guard-confirmation-approve",
  decline: "webmcp-guard-confirmation-decline",
} as const;

/* ------------------------------------------------ the DOM, narrowly typed -- */

interface ModalElement {
  style: { cssText: string };
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: ModalElement): unknown;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
  remove(): void;
  focus?(): void;
}

interface ModalKeyEvent {
  key?: string;
  preventDefault?(): void;
}

interface ModalDocument {
  createElement(tag: string): ModalElement;
  body?: { appendChild(child: ModalElement): unknown } | null;
  addEventListener(type: string, listener: (event: ModalKeyEvent) => void): void;
  removeEventListener(type: string, listener: (event: ModalKeyEvent) => void): void;
}

/** The live `document`, when it is one this modal can actually build in. */
function resolveModalDocument(): ModalDocument | null {
  const candidate = guardGlobals().document as unknown as Partial<ModalDocument> | undefined;
  if (!candidate) return null;
  if (typeof candidate.createElement !== "function") return null;
  if (!candidate.body || typeof candidate.body.appendChild !== "function") return null;
  return candidate as ModalDocument;
}

/* ---------------------------------------------------------------- styles -- */

const Z_INDEX = 2147483000;

const OVERLAY_CSS = [
  "position:fixed",
  "inset:0",
  `z-index:${Z_INDEX}`,
  "display:flex",
  "align-items:center",
  "justify-content:center",
  "padding:24px",
  "background:rgba(2,6,23,0.72)",
  "backdrop-filter:blur(2px)",
  "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
].join(";");

const DIALOG_CSS = [
  "box-sizing:border-box",
  "width:100%",
  "max-width:480px",
  "max-height:100%",
  "overflow:auto",
  "background:#0f172a",
  "color:#e2e8f0",
  "border:1px solid #334155",
  "border-radius:12px",
  "padding:20px",
  "box-shadow:0 24px 60px rgba(0,0,0,0.55)",
  "text-align:left",
].join(";");

const EYEBROW_CSS = [
  "margin:0 0 6px",
  "font-size:11px",
  "font-weight:600",
  "letter-spacing:0.08em",
  "text-transform:uppercase",
  "color:#38bdf8",
].join(";");

const TITLE_CSS = ["margin:0 0 10px", "font-size:17px", "font-weight:650", "color:#f8fafc"].join(
  ";",
);

const MESSAGE_CSS = ["margin:0 0 14px", "font-size:14px", "line-height:1.5", "color:#cbd5e1"].join(
  ";",
);

const LABEL_CSS = [
  "margin:0 0 4px",
  "font-size:11px",
  "font-weight:600",
  "letter-spacing:0.06em",
  "text-transform:uppercase",
  "color:#94a3b8",
].join(";");

const ARGS_CSS = [
  "margin:0 0 16px",
  "padding:10px",
  "max-height:180px",
  "overflow:auto",
  "background:#020617",
  "border:1px solid #1e293b",
  "border-radius:8px",
  "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
  "font-size:11px",
  "line-height:1.45",
  "color:#e2e8f0",
  "white-space:pre-wrap",
  "word-break:break-word",
].join(";");

const FOOTER_CSS = ["display:flex", "gap:8px", "justify-content:flex-end"].join(";");

const BUTTON_CSS = [
  "appearance:none",
  "cursor:pointer",
  "border-radius:8px",
  "padding:8px 14px",
  "font-size:13px",
  "font-weight:600",
  "font-family:inherit",
  "line-height:1.2",
].join(";");

const DECLINE_CSS = `${BUTTON_CSS};background:#1e293b;color:#e2e8f0;border:1px solid #475569`;
const APPROVE_CSS = `${BUTTON_CSS};background:#dc2626;color:#fff;border:1px solid #ef4444`;

/* ------------------------------------------------------------------ modal -- */

/** Longest pretty-printed argument block shown, so a bulk call cannot fill the screen. */
const MAX_ARGS_TEXT = 2000;

/** Pretty JSON for the args block. Never throws; never returns markup. */
export function formatConfirmationArgs(args: JsonObject): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    text = "(these arguments could not be displayed)";
  }
  return text.length > MAX_ARGS_TEXT ? `${text.slice(0, MAX_ARGS_TEXT)}\n…` : text;
}

/**
 * Only one modal at a time, page-wide.
 *
 * Concurrent calls **queue** rather than being rejected: two agent calls can be
 * in flight at once, and turning the second one into an automatic decline would
 * be a confusing lie about what the person chose. A queued request that is
 * aborted while waiting never renders at all.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue(task: () => Promise<ConfirmationDecision>): Promise<ConfirmationDecision> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The default handler: builds the modal, resolves with what the person chose.
 *
 * Fails **closed** in every degenerate case — no DOM, an aborted call, an
 * exception mid-render — because "nobody could be asked" is not approval.
 */
export const defaultConfirmationHandler: ConfirmationHandler = (request) =>
  enqueue(() => renderConfirmationModal(request));

function renderConfirmationModal(request: ConfirmationRequest): Promise<ConfirmationDecision> {
  if (request.signal?.aborted) return Promise.resolve("cancelled");

  const document = resolveModalDocument();
  if (document === null) {
    console.warn(
      "[WebMCP Guard] a tool call needs human approval, but there is no DOM to ask in. " +
        "Treating it as declined. Pass `confirmationHandler` to createGuard() for a headless host.",
    );
    return Promise.resolve("declined");
  }

  return new Promise<ConfirmationDecision>((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", CONFIRMATION_TEST_IDS.overlay);
    overlay.style.cssText = OVERLAY_CSS;

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", `Approve ${request.tool}?`);
    dialog.style.cssText = DIALOG_CSS;

    const eyebrow = document.createElement("p");
    eyebrow.style.cssText = EYEBROW_CSS;
    eyebrow.textContent = "WebMCP Guard · approval required";

    const title = document.createElement("h2");
    title.setAttribute("data-testid", CONFIRMATION_TEST_IDS.tool);
    title.style.cssText = TITLE_CSS;
    // `textContent`, never innerHTML: the tool name and the arguments below are
    // written by the agent, and this dialog must not be a markup injection
    // point into the host page.
    title.textContent = `An agent wants to run “${request.tool}”`;

    const message = document.createElement("p");
    message.setAttribute("data-testid", CONFIRMATION_TEST_IDS.message);
    message.style.cssText = MESSAGE_CSS;
    message.textContent = request.message;

    const label = document.createElement("p");
    label.style.cssText = LABEL_CSS;
    label.textContent = "Arguments";

    const args = document.createElement("pre");
    args.setAttribute("data-testid", CONFIRMATION_TEST_IDS.args);
    args.style.cssText = ARGS_CSS;
    args.textContent = formatConfirmationArgs(request.args);

    const footer = document.createElement("div");
    footer.style.cssText = FOOTER_CSS;

    const decline = document.createElement("button");
    decline.setAttribute("type", "button");
    decline.setAttribute("data-testid", CONFIRMATION_TEST_IDS.decline);
    decline.style.cssText = DECLINE_CSS;
    decline.textContent = "Decline";

    const approve = document.createElement("button");
    approve.setAttribute("type", "button");
    approve.setAttribute("data-testid", CONFIRMATION_TEST_IDS.approve);
    approve.style.cssText = APPROVE_CSS;
    approve.textContent = "Approve";

    footer.appendChild(decline);
    footer.appendChild(approve);
    for (const child of [eyebrow, title, message, label, args, footer]) dialog.appendChild(child);
    overlay.appendChild(dialog);

    let settled = false;
    const onKeyDown = (event: ModalKeyEvent) => {
      // Escape declines. Dismissing a dialog is never an approval.
      if (event.key === "Escape") {
        event.preventDefault?.();
        settle("declined");
      }
    };
    const onAbort = () => settle("cancelled");

    function settle(decision: ConfirmationDecision): void {
      if (settled) return;
      settled = true;
      try {
        document?.removeEventListener("keydown", onKeyDown);
        request.signal?.removeEventListener("abort", onAbort);
        overlay.remove();
      } catch {
        // A host that tore the node out from under us is not a reason to leave
        // the tool call hanging forever.
      }
      resolve(decision);
    }

    approve.addEventListener("click", () => settle("approved"));
    decline.addEventListener("click", () => settle("declined"));
    document.addEventListener("keydown", onKeyDown);
    request.signal?.addEventListener("abort", onAbort);

    document.body?.appendChild(overlay);
    // Focus lands on Decline: if a stray keystroke activates a button, it must
    // be the safe one.
    decline.focus?.();
  });
}
