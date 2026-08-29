import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_TEST_IDS,
  defaultConfirmationHandler,
  formatConfirmationArgs,
  type ConfirmationRequest,
} from "./confirmation";
import {
  FakeDocument,
  clearBrowserGlobals,
  defineGlobal,
  restoreBrowserGlobals,
} from "./test-support";

/**
 * The built-in approval modal.
 *
 * The rule every test here is really checking: **nothing but a click on Approve
 * produces an approval.** No DOM, an abort, a stray keypress, a handler that
 * blew up — all of them are declines or cancellations, never approvals.
 */

let document: FakeDocument;

function request(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    app: "lakeside-portal",
    tool: "delete_patient",
    message: "Destructive actions have to be approved by the person using this page.",
    args: { patient: "LM-100060" },
    callId: "call-1",
    confirmationId: "conf-1",
    ...overrides,
  };
}

/** Yields until the modal has rendered (it starts on a microtask). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10 && document.find(CONFIRMATION_TEST_IDS.overlay) === null; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Starts the handler and waits for its modal to be in the document.
 *
 * The pending decision is returned **wrapped**: an async function that returned
 * it directly would adopt it, and every test would wait forever for a modal
 * nobody had clicked yet.
 */
async function open(
  overrides: Partial<ConfirmationRequest> = {},
): Promise<{ decision: Promise<string> }> {
  const decision = Promise.resolve(defaultConfirmationHandler(request(overrides)));
  await settle();
  return { decision };
}

beforeEach(() => {
  clearBrowserGlobals();
  document = new FakeDocument();
  defineGlobal("document", document);
});

afterEach(() => {
  restoreBrowserGlobals();
  vi.restoreAllMocks();
});

describe("defaultConfirmationHandler", () => {
  it("shows the tool, the policy message and the arguments", async () => {
    const { decision } = await open();

    const overlay = document.find(CONFIRMATION_TEST_IDS.overlay);
    expect(overlay).not.toBeNull();
    expect(document.find(CONFIRMATION_TEST_IDS.tool)?.textContent).toContain("delete_patient");
    expect(document.find(CONFIRMATION_TEST_IDS.message)?.textContent).toBe(request().message);
    expect(document.find(CONFIRMATION_TEST_IDS.args)?.textContent).toContain("LM-100060");

    document.find(CONFIRMATION_TEST_IDS.decline)?.click();
    await expect(decision).resolves.toBe("declined");
  });

  it("renders text, never markup", async () => {
    const { decision } = await open({
      tool: "<img src=x onerror=alert(1)>",
      args: { note: "<script>steal()</script>" },
    });

    // Everything the agent controls is set through `textContent`, so a hostile
    // tool name or argument is displayed, not parsed.
    const title = document.find(CONFIRMATION_TEST_IDS.tool);
    expect(title?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(title?.children).toHaveLength(0);
    expect(document.find(CONFIRMATION_TEST_IDS.args)?.children).toHaveLength(0);

    document.find(CONFIRMATION_TEST_IDS.decline)?.click();
    await decision;
  });

  it("resolves 'approved' when Approve is clicked, and cleans up after itself", async () => {
    const { decision } = await open();
    document.find(CONFIRMATION_TEST_IDS.approve)?.click();

    await expect(decision).resolves.toBe("approved");
    expect(document.find(CONFIRMATION_TEST_IDS.overlay)).toBeNull();
    expect(document.keydownListeners).toBe(0);
  });

  it("resolves 'declined' when Decline is clicked", async () => {
    const { decision } = await open();
    document.find(CONFIRMATION_TEST_IDS.decline)?.click();

    await expect(decision).resolves.toBe("declined");
    expect(document.find(CONFIRMATION_TEST_IDS.overlay)).toBeNull();
  });

  it("treats Escape as a decline, never as a dismissal", async () => {
    const { decision } = await open();
    document.press("Escape");

    await expect(decision).resolves.toBe("declined");
    expect(document.find(CONFIRMATION_TEST_IDS.overlay)).toBeNull();
  });

  it("ignores other keys", async () => {
    const { decision } = await open();
    document.press("Enter");
    document.press("a");

    expect(document.find(CONFIRMATION_TEST_IDS.overlay)).not.toBeNull();
    document.find(CONFIRMATION_TEST_IDS.decline)?.click();
    await expect(decision).resolves.toBe("declined");
  });

  it("focuses Decline, so a stray keystroke cannot approve", async () => {
    const { decision } = await open();

    expect(document.find(CONFIRMATION_TEST_IDS.decline)?.focused).toBe(true);
    expect(document.find(CONFIRMATION_TEST_IDS.approve)?.focused).toBe(false);

    document.find(CONFIRMATION_TEST_IDS.decline)?.click();
    await decision;
  });

  it("answers only once, however many buttons are clicked", async () => {
    const { decision } = await open();
    const approve = document.body.find(CONFIRMATION_TEST_IDS.approve);
    const decline = document.body.find(CONFIRMATION_TEST_IDS.decline);

    approve?.click();
    decline?.click();
    approve?.click();

    await expect(decision).resolves.toBe("approved");
  });

  describe("cancellation", () => {
    it("closes and reports 'cancelled' when the call is aborted", async () => {
      const controller = new AbortController();
      const { decision } = await open({ signal: controller.signal });

      expect(document.find(CONFIRMATION_TEST_IDS.overlay)).not.toBeNull();
      controller.abort();

      await expect(decision).resolves.toBe("cancelled");
      expect(document.find(CONFIRMATION_TEST_IDS.overlay)).toBeNull();
      expect(document.keydownListeners).toBe(0);
    });

    it("never renders for a call that was already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        defaultConfirmationHandler(request({ signal: controller.signal })),
      ).resolves.toBe("cancelled");
      expect(document.body.descendants()).toHaveLength(0);
    });
  });

  describe("without a DOM to ask in", () => {
    it("declines rather than approving by default", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      clearBrowserGlobals();

      await expect(defaultConfirmationHandler(request())).resolves.toBe("declined");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("no DOM to ask in");
    });

    it("declines when the document cannot host a modal", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      defineGlobal("document", { modelContext: {} });

      await expect(defaultConfirmationHandler(request())).resolves.toBe("declined");
    });
  });

  it("shows one modal at a time and queues the rest", async () => {
    const { decision: first } = await open({ tool: "delete_patient" });
    const second = defaultConfirmationHandler(request({ tool: "export_patients" }));

    // The second request is waiting, not rendering over the first.
    expect(document.find(CONFIRMATION_TEST_IDS.tool)?.textContent).toContain("delete_patient");

    document.find(CONFIRMATION_TEST_IDS.decline)?.click();
    await expect(first).resolves.toBe("declined");

    await settle();
    expect(document.find(CONFIRMATION_TEST_IDS.tool)?.textContent).toContain("export_patients");

    document.find(CONFIRMATION_TEST_IDS.approve)?.click();
    await expect(second).resolves.toBe("approved");
  });
});

describe("formatConfirmationArgs", () => {
  it("pretty-prints so a person can read what they are approving", () => {
    expect(formatConfirmationArgs({ patient: "LM-100060" })).toBe('{\n  "patient": "LM-100060"\n}');
  });

  it("caps a bulk payload instead of filling the screen", () => {
    const text = formatConfirmationArgs({
      rows: Array.from({ length: 500 }, (_, i) => `row-${i}`),
    });
    expect(text.length).toBeLessThan(2100);
    expect(text.endsWith("…")).toBe(true);
  });

  it("says so rather than throwing on something unserializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatConfirmationArgs(circular)).toContain("could not be displayed");
  });
});
