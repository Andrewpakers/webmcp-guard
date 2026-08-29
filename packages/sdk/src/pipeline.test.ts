import { GateRequestSchema, TransformRequestSchema } from "@webmcp-guard/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_NOT_ACCEPTED_MESSAGE,
  BLOCKED_FALLBACK_MESSAGE,
  CANCELLED_MESSAGE,
  CONFIRMATION_UNAVAILABLE_MESSAGE,
  EMPTY_RESULT_MESSAGE,
  type BlockedInfo,
  type ConfirmationHandler,
  type ConfirmationRequest,
  type GuardEvent,
  type GuardToolDefinition,
  createGuard,
  declinedMessage,
  executeFailedMessage,
  verificationFailedMessage,
} from "./index";
import {
  StubModelContext,
  abortError,
  clearBrowserGlobals,
  createFetchStub,
  defineGlobal,
  envelopeResponse,
  makeToolDefinition,
  restoreBrowserGlobals,
  type FetchRoute,
  type FetchStub,
} from "./test-support";

/**
 * The execute pipeline: gate → execute → transform, and every way it can fail.
 *
 * The raw result of every tool here is a marker string. Any assertion that the
 * marker is absent from what the agent received is a fail-closed assertion:
 * unclassified, unlogged data must never reach the model.
 */

const RAW = "RAW-SECRET-SSN-123-45-6789";

interface Harness {
  guard: ReturnType<typeof createGuard>;
  modelContext: StubModelContext;
  fetchStub: FetchStub;
  events: GuardEvent[];
  blocked: BlockedInfo[];
  order: string[];
  /** Invokes the registered tool the way Chromium 151 does: input only. */
  call(input?: unknown): Promise<unknown>;
  /** Invokes it the way the spec documents: `(input, { signal })`. */
  callWithContext(input?: unknown, signal?: AbortSignal): Promise<unknown>;
}

const allowResponse = (args?: Record<string, unknown>) =>
  envelopeResponse({
    callId: "call_1",
    verdict: "allow",
    ruleIds: ["R-allow"],
    ...(args ? { args } : {}),
  });

const transformResponse = (result: unknown) =>
  envelopeResponse({ result, classesFound: [], ruleIds: ["R-transform"] });

async function setup(
  routes: { gate?: FetchRoute; transform?: FetchRoute; policies?: FetchRoute } = {},
  init: {
    definition?: Partial<GuardToolDefinition>;
    getSessionContext?: () => { userId?: string; role?: string } | undefined;
    onBlockedThrows?: boolean;
    confirmationHandler?: ConfirmationHandler;
  } = {},
): Promise<Harness> {
  const modelContext = new StubModelContext();
  defineGlobal("document", { modelContext });

  const order: string[] = [];
  const fetchStub = createFetchStub({
    gate: (call) => {
      order.push("gate");
      return (routes.gate ?? (() => allowResponse()))(call);
    },
    transform: (call) => {
      order.push("transform");
      return (routes.transform ?? (() => transformResponse(RAW)))(call);
    },
    ...(routes.policies ? { policies: routes.policies } : {}),
  });

  const events: GuardEvent[] = [];
  const blocked: BlockedInfo[] = [];
  const guard = createGuard({
    endpoint: "/api/guard",
    app: "lakeside-portal",
    fetchImpl: fetchStub.fetchImpl,
    getSessionContext: init.getSessionContext,
    onBlocked: (info) => {
      blocked.push(info);
      if (init.onBlockedThrows) throw new Error("toast exploded");
    },
    ...(init.confirmationHandler ? { confirmationHandler: init.confirmationHandler } : {}),
  });
  guard.subscribe((event) => events.push(event));

  const definition = makeToolDefinition({
    execute: (input, context) => {
      order.push("execute");
      void input;
      void context;
      return RAW;
    },
    ...init.definition,
  });
  await guard.registerTool(definition);

  return {
    guard,
    modelContext,
    fetchStub,
    events,
    blocked,
    order,
    call: (input) => modelContext.executeToolWithoutContext(definition.name, input),
    callWithContext: (input, signal) => modelContext.executeTool(definition.name, input, signal),
  };
}

beforeEach(() => {
  clearBrowserGlobals();
});

afterEach(() => {
  restoreBrowserGlobals();
  vi.restoreAllMocks();
});

describe("happy path", () => {
  it("runs gate → execute → transform, in that order", async () => {
    const harness = await setup({ transform: () => transformResponse("tokenized result") });

    await expect(harness.call({ query: "smith" })).resolves.toBe("tokenized result");
    expect(harness.order).toEqual(["gate", "execute", "transform"]);
  });

  it("works when the browser calls execute with only one argument", async () => {
    // Chromium 151 does exactly this, despite the spec's `(input, { signal })`.
    const harness = await setup({ transform: () => transformResponse("ok") });
    await expect(harness.call({ query: "smith" })).resolves.toBe("ok");
  });

  it("sends a well-formed gate envelope", async () => {
    const harness = await setup(
      {},
      { getSessionContext: () => ({ userId: "u-1", role: "front-desk" }) },
    );
    await harness.call({ query: "smith" });

    const [gateCall] = harness.fetchStub.gateCalls;
    expect(gateCall.url).toBe("/api/guard/gate");
    expect(gateCall.init.method).toBe("POST");
    expect(gateCall.envelope.version).toBe(1);
    expect(gateCall.payload).toMatchObject({
      app: "lakeside-portal",
      tool: "search_patients",
      args: { query: "smith" },
      toolTags: ["read", "phi"],
      sessionContext: { userId: "u-1", role: "front-desk" },
    });
    const posture = gateCall.payload.posture as Record<string, unknown>;
    expect(typeof posture.timestamp).toBe("string");
    expect(posture.isSecureContext).toBe(false);
  });

  it("omits toolTags when the definition has none", async () => {
    const harness = await setup({}, { definition: { tags: undefined } });
    await harness.call({});
    expect(harness.fetchStub.gateCalls[0].payload).not.toHaveProperty("toolTags");
  });

  it("sends the callId and the raw result to /transform", async () => {
    const harness = await setup();
    await harness.call({ query: "smith" });

    const [transformCall] = harness.fetchStub.transformCalls;
    expect(transformCall.url).toBe("/api/guard/transform");
    expect(transformCall.envelope.version).toBe(1);
    expect(transformCall.payload).toEqual({
      app: "lakeside-portal",
      tool: "search_patients",
      callId: "call_1",
      result: RAW,
    });
  });

  it("executes with the gate's detokenized args when it returns them", async () => {
    const seen: unknown[] = [];
    const harness = await setup(
      { gate: () => allowResponse({ query: "smith", mrn: "LM-100042" }) },
      {
        definition: {
          execute: (input) => {
            seen.push(input);
            return RAW;
          },
        },
      },
    );

    await harness.call({ query: "smith", mrn: "tok_mrn_abcd1234" });
    expect(seen).toEqual([{ query: "smith", mrn: "LM-100042" }]);
  });

  it("executes with the agent's own args when the gate returns none", async () => {
    const seen: unknown[] = [];
    const harness = await setup(
      {},
      {
        definition: {
          execute: (input) => {
            seen.push(input);
            return RAW;
          },
        },
      },
    );

    const input = { query: "smith" };
    await harness.call(input);
    expect(seen[0]).toBe(input);
  });

  it("treats a missing input as an empty argument object", async () => {
    const seen: unknown[] = [];
    const harness = await setup(
      {},
      {
        definition: {
          execute: (input) => {
            seen.push(input);
            return RAW;
          },
        },
      },
    );

    await harness.call(undefined);
    expect(seen).toEqual([{}]);
    expect(harness.fetchStub.gateCalls[0].payload.args).toEqual({});
  });

  it("returns a transformed string verbatim and JSON-encodes anything else", async () => {
    const stringHarness = await setup({ transform: () => transformResponse("Patient tok_name_1") });
    await expect(stringHarness.call({})).resolves.toBe("Patient tok_name_1");

    const objectHarness = await setup({
      transform: () => transformResponse({ mrn: "tok_mrn_1", visits: 2 }),
    });
    await expect(objectHarness.call({})).resolves.toBe('{"mrn":"tok_mrn_1","visits":2}');
  });

  it("says so in plain English when the transform returns nothing", async () => {
    const harness = await setup({ transform: () => transformResponse(undefined) });
    await expect(harness.call({})).resolves.toBe(EMPTY_RESULT_MESSAGE);
  });
});

describe("deny", () => {
  const denyResponse = (message?: string) =>
    envelopeResponse({
      callId: "call_denied",
      verdict: "deny",
      ruleIds: ["P-7"],
      ...(message ? { message } : {}),
    });

  it("never runs execute and hands the agent the server's message", async () => {
    const message = "Blocked by policy P-7: destructive actions require justification.";
    const harness = await setup({ gate: () => denyResponse(message) });

    await expect(harness.call({ mrn: "LM-100042" })).resolves.toBe(message);
    expect(harness.order).toEqual(["gate"]);
    expect(harness.fetchStub.transformCalls).toHaveLength(0);
  });

  it("calls onBlocked and emits a blocked event", async () => {
    const message = "Blocked by policy P-7.";
    const harness = await setup({ gate: () => denyResponse(message) });
    await harness.call({});

    expect(harness.blocked).toEqual([
      {
        tool: "search_patients",
        callId: "call_denied",
        verdict: "deny",
        message,
        ruleIds: ["P-7"],
      },
    ]);
    expect(harness.events.map((event) => event.type)).toEqual(["gate", "blocked"]);
    expect(harness.events[1]).toMatchObject({
      verdict: "deny",
      callId: "call_denied",
      detail: message,
    });
  });

  it("falls back to a generic message when the server sends none", async () => {
    const harness = await setup({ gate: () => denyResponse() });
    await expect(harness.call({})).resolves.toBe(BLOCKED_FALLBACK_MESSAGE);
  });

  it("still blocks when the host's onBlocked handler throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await setup({ gate: () => denyResponse("nope") }, { onBlockedThrows: true });

    await expect(harness.call({})).resolves.toBe("nope");
    expect(harness.order).toEqual(["gate"]);
  });

  it("blocks a require-justification verdict with the guard's instructions", async () => {
    const message = 'Justification required: call "export_patients" again with a justification.';
    const harness = await setup({
      gate: () =>
        envelopeResponse({
          callId: "call_x",
          verdict: "require-justification",
          ruleIds: ["R-1"],
          message,
        }),
    });

    await expect(harness.call({})).resolves.toBe(message);
    expect(harness.order).toEqual(["gate"]);
    expect(harness.blocked[0].verdict).toBe("require-justification");
  });

  it("fails closed on a confirmation verdict that carries no id to approve", async () => {
    const harness = await setup({
      gate: () =>
        envelopeResponse({ callId: "call_x", verdict: "require-confirmation", ruleIds: ["R-1"] }),
    });

    // Nothing to approve means nothing runs — and the agent is told to ask a
    // person rather than to retry.
    await expect(harness.call({})).resolves.toBe(CONFIRMATION_UNAVAILABLE_MESSAGE);
    expect(harness.order).toEqual(["gate"]);
  });
});

/**
 * The confirmation round trip (`docs/04` behavior 4, `docs/05` demo step 4).
 *
 * The shape under test: gate says `require-confirmation` and hands back a
 * one-time id → the SDK asks a person → **only** on approval does it re-issue
 * the identical gate call with that id → the second verdict is the real one.
 *
 * A stub handler stands in for the modal here; the modal itself is covered in
 * `confirmation.test.ts`, and driven for real in the headless-Chromium e2e run.
 */
describe("human confirmation", () => {
  const POLICY_MESSAGE =
    "Human confirmation required by policy Destructive tools require human confirmation " +
    "(destructive-requires-confirmation): approve this in the page.";

  /** Answers `require-confirmation` first, then whatever the id earns. */
  function confirmingGate(
    second: (call: { payload: Record<string, unknown> }) => Response,
  ): FetchRoute {
    let asked = false;
    return (call) => {
      if (!asked) {
        asked = true;
        return envelopeResponse({
          callId: "call_ask",
          verdict: "require-confirmation",
          confirmationId: "conf_1",
          ruleIds: ["destructive-requires-confirmation"],
          message: POLICY_MESSAGE,
        });
      }
      return second(call);
    };
  }

  const approvedGate = () =>
    confirmingGate((call) =>
      envelopeResponse({
        callId: "call_run",
        verdict: "allow",
        args: (call.payload as { args: Record<string, unknown> }).args,
        ruleIds: ["destructive-requires-confirmation"],
        message: "The person using this page approved this call, so it ran.",
      }),
    );

  function stubHandler(decision: "approved" | "declined" | "cancelled") {
    const seen: ConfirmationRequest[] = [];
    const handler: ConfirmationHandler = (request) => {
      seen.push(request);
      return decision;
    };
    return { handler, seen };
  }

  it("describes the call to the person, exactly as the guard bound it", async () => {
    const { handler, seen } = stubHandler("declined");
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    await harness.call({ patient: "LM-100060" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      app: "lakeside-portal",
      tool: "search_patients",
      callId: "call_ask",
      confirmationId: "conf_1",
      message: POLICY_MESSAGE,
      args: { patient: "LM-100060" },
    });
  });

  it("re-issues the same call with the id and runs it on approval", async () => {
    const { handler } = stubHandler("approved");
    const harness = await setup(
      { gate: approvedGate(), transform: () => transformResponse("deleted") },
      { confirmationHandler: handler },
    );

    await expect(harness.call({ patient: "LM-100060" })).resolves.toBe("deleted");

    // Two gate calls: the ask, then the approved one carrying the id.
    expect(harness.fetchStub.gateCalls).toHaveLength(2);
    expect(harness.fetchStub.gateCalls[0].payload.confirmationId).toBeUndefined();
    expect(harness.fetchStub.gateCalls[1].payload).toMatchObject({
      tool: "search_patients",
      args: { patient: "LM-100060" },
      confirmationId: "conf_1",
    });
    expect(harness.order).toEqual(["gate", "gate", "execute", "transform"]);
  });

  it("returns the declined message and never runs the tool", async () => {
    const { handler } = stubHandler("declined");
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    const result = await harness.call({ patient: "LM-100060" });

    expect(String(result)).toContain("the person at the keyboard declined");
    // The policy's own explanation travels with it, so the model has the reason.
    expect(String(result)).toContain(POLICY_MESSAGE);
    expect(result).toBe(declinedMessage(POLICY_MESSAGE));
    expect(harness.order).toEqual(["gate"]);
    expect(harness.fetchStub.gateCalls).toHaveLength(1);
    expect(harness.fetchStub.transformCalls).toHaveLength(0);
  });

  it("fires onBlocked and a blocked event on a decline", async () => {
    const { handler } = stubHandler("declined");
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    await harness.call({});

    expect(harness.events.map((event) => event.type)).toEqual(["gate", "confirmation", "blocked"]);
    expect(harness.events[1]).toMatchObject({
      type: "confirmation",
      decision: "declined",
      callId: "call_ask",
    });
    expect(harness.blocked).toHaveLength(1);
    expect(harness.blocked[0]).toMatchObject({
      verdict: "require-confirmation",
      callId: "call_ask",
    });
  });

  it("emits an approved confirmation event for the activity drawer", async () => {
    const { handler } = stubHandler("approved");
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    await harness.call({});

    expect(harness.events.map((event) => event.type)).toEqual([
      "gate",
      "confirmation",
      "gate",
      "executed",
      "transformed",
    ]);
    expect(harness.events[1]).toMatchObject({ decision: "approved" });
    expect(harness.events[1].detail).toContain("approved");
  });

  it("reports cancellation when the call is abandoned mid-modal", async () => {
    const controller = new AbortController();
    const handler: ConfirmationHandler = () => {
      controller.abort();
      return "cancelled";
    };
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    await expect(harness.callWithContext({}, controller.signal)).resolves.toBe(CANCELLED_MESSAGE);
    expect(harness.order).toEqual(["gate"]);
    expect(harness.events.at(-1)).toMatchObject({ type: "confirmation", decision: "cancelled" });
  });

  it("does not run the call when the signal aborted while the modal was open", async () => {
    const controller = new AbortController();
    // A handler that says "approved" after the call was already abandoned must
    // not resurrect it.
    const handler: ConfirmationHandler = () => {
      controller.abort();
      return "approved";
    };
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    await expect(harness.callWithContext({}, controller.signal)).resolves.toBe(CANCELLED_MESSAGE);
    expect(harness.fetchStub.gateCalls).toHaveLength(1);
    expect(harness.order).toEqual(["gate"]);
  });

  it("treats a handler that throws as a decline", async () => {
    const handler: ConfirmationHandler = () => {
      throw new Error("modal blew up");
    };
    const harness = await setup({ gate: approvedGate() }, { confirmationHandler: handler });

    const result = await harness.call({});

    expect(String(result)).toContain("declined");
    expect(harness.order).toEqual(["gate"]);
    expect(harness.events.some((event) => event.detail?.includes("modal blew up"))).toBe(true);
  });

  it("stops when the approved call is refused by the guard", async () => {
    const { handler } = stubHandler("approved");
    const denial = "Blocked by policy: that approval has already been used.";
    const harness = await setup(
      {
        gate: confirmingGate(() =>
          envelopeResponse({
            callId: "call_denied",
            verdict: "deny",
            ruleIds: ["destructive-requires-confirmation"],
            message: denial,
          }),
        ),
      },
      { confirmationHandler: handler },
    );

    await expect(harness.call({})).resolves.toBe(denial);
    expect(harness.order).toEqual(["gate", "gate"]);
    expect(harness.fetchStub.transformCalls).toHaveLength(0);
  });

  it("explains a silent refusal of an approval the person did give", async () => {
    const { handler } = stubHandler("approved");
    const harness = await setup(
      {
        gate: confirmingGate(() =>
          envelopeResponse({ callId: "call_denied", verdict: "deny", ruleIds: [] }),
        ),
      },
      { confirmationHandler: handler },
    );

    await expect(harness.call({})).resolves.toBe(APPROVAL_NOT_ACCEPTED_MESSAGE);
  });

  it("never loops, even if the guard asks for confirmation twice", async () => {
    const { handler, seen } = stubHandler("approved");
    const harness = await setup(
      {
        gate: () =>
          envelopeResponse({
            callId: "call_ask",
            verdict: "require-confirmation",
            confirmationId: "conf_1",
            ruleIds: ["R-1"],
            message: POLICY_MESSAGE,
          }),
      },
      { confirmationHandler: handler },
    );

    await harness.call({});

    // One ask, one re-issue, then it stops: an agent cannot drive a modal storm.
    expect(seen).toHaveLength(1);
    expect(harness.fetchStub.gateCalls).toHaveLength(2);
    expect(harness.order).toEqual(["gate", "gate"]);
  });
});

describe("fail closed — gate", () => {
  const cases: Array<[string, FetchRoute]> = [
    ["a 500 response", () => envelopeResponse({}, { status: 500 })],
    [
      "a network failure",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["a non-JSON body", () => new Response("<html>gateway timeout</html>", { status: 200 })],
    ["a payload that fails schema validation", () => envelopeResponse({ verdict: "allow" })],
    ["a response with no callId", () => envelopeResponse({ verdict: "allow", ruleIds: [] })],
    ["an unknown verdict", () => envelopeResponse({ callId: "c", verdict: "maybe", ruleIds: [] })],
    [
      "a future wire version",
      () => envelopeResponse({ callId: "c", verdict: "allow", ruleIds: [] }, { version: 2 }),
    ],
    [
      "a bare payload with no envelope",
      () => Response.json({ callId: "c", verdict: "allow", ruleIds: [] }),
    ],
  ];

  it.each(cases)("refuses to execute after %s", async (_label, gate) => {
    const harness = await setup({ gate });

    const result = await harness.call({ query: "smith" });

    expect(result).toBe(verificationFailedMessage("gate"));
    expect(harness.order).toEqual(["gate"]);
    expect(harness.events.map((event) => event.type)).toEqual(["error"]);
    expect(String(result)).not.toContain(RAW);
  });
});

describe("fail closed — transform", () => {
  const cases: Array<[string, FetchRoute]> = [
    ["a 500 response", () => envelopeResponse({}, { status: 500 })],
    [
      "a network failure",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    ["a non-JSON body", () => new Response("nope", { status: 200 })],
    ["a payload that fails schema validation", () => envelopeResponse({ result: "x" })],
    [
      "a future wire version",
      () => envelopeResponse({ result: "x", classesFound: [], ruleIds: [] }, { version: 2 }),
    ],
  ];

  it.each(cases)("withholds the raw result after %s", async (_label, transform) => {
    const harness = await setup({ transform });

    const result = await harness.call({ query: "smith" });

    expect(result).toBe(verificationFailedMessage("transform"));
    expect(String(result)).not.toContain(RAW);
    expect(String(result)).not.toContain("SECRET");
    // The tool did run in the page — the human saw it — but the agent gets nothing.
    expect(harness.order).toEqual(["gate", "execute", "transform"]);
    expect(harness.events.map((event) => event.type)).toEqual(["gate", "executed", "error"]);
  });

  it("withholds a result that cannot be serialized for the wire", async () => {
    const circular: Record<string, unknown> = { name: RAW };
    circular.self = circular;
    const harness = await setup({}, { definition: { execute: () => circular } });

    const result = await harness.call({});
    expect(result).toBe(verificationFailedMessage("transform"));
    expect(harness.fetchStub.transformCalls).toHaveLength(0);
  });
});

describe("execute failures", () => {
  it("returns actionable prose and leaks nothing from the thrown error", async () => {
    const harness = await setup(
      {},
      {
        definition: {
          execute: () => {
            throw new Error(`SQLITE_ERROR near "SELECT ssn": ${RAW}`);
          },
        },
      },
    );

    const result = await harness.call({});

    expect(result).toBe(executeFailedMessage("search_patients"));
    expect(String(result)).not.toContain(RAW);
    expect(String(result)).not.toContain("SQLITE_ERROR");
    expect(harness.fetchStub.transformCalls).toHaveLength(0);
  });

  it("keeps the real reason in the page-local event stream", async () => {
    const harness = await setup(
      {},
      {
        definition: {
          execute: () => {
            throw new Error("patient not found");
          },
        },
      },
    );
    await harness.call({});

    const error = harness.events.find((event) => event.type === "error");
    expect(error?.detail).toContain("patient not found");
    expect(error?.callId).toBe("call_1");
  });

  it("handles a rejected promise as well as a synchronous throw", async () => {
    const harness = await setup(
      {},
      { definition: { execute: () => Promise.reject(new Error("boom")) } },
    );
    await expect(harness.call({})).resolves.toBe(executeFailedMessage("search_patients"));
  });
});

describe("invalid arguments", () => {
  const badInputs: Array<[string, unknown]> = [
    ["an array", []],
    ["a string", "smith"],
    ["a number", 7],
  ];

  it.each(badInputs)("refuses %s before calling the gate", async (_label, input) => {
    const harness = await setup();

    const result = await harness.call(input);

    expect(String(result)).toContain("were not a JSON object");
    expect(harness.fetchStub.pipelineCalls).toHaveLength(0);
    expect(harness.order).toEqual([]);
  });
});

describe("abort", () => {
  it("stops before the gate when the signal is already aborted", async () => {
    const harness = await setup();
    const controller = new AbortController();
    controller.abort();

    await expect(harness.callWithContext({}, controller.signal)).resolves.toBe(CANCELLED_MESSAGE);
    expect(harness.fetchStub.pipelineCalls).toHaveLength(0);
    expect(harness.events.at(-1)).toMatchObject({ type: "error" });
    expect(harness.events.at(-1)?.detail).toContain("cancelled");
  });

  it("forwards the signal to both guard round trips", async () => {
    const harness = await setup();
    const controller = new AbortController();

    await harness.callWithContext({ query: "smith" }, controller.signal);

    expect(harness.fetchStub.pipelineCalls).toHaveLength(2);
    for (const call of harness.fetchStub.pipelineCalls) {
      expect(call.init.signal).toBe(controller.signal);
    }
  });

  it("forwards the browser's context to the site's execute", async () => {
    const contexts: unknown[] = [];
    const harness = await setup(
      {},
      {
        definition: {
          execute: (_input, context) => {
            contexts.push(context);
            return RAW;
          },
        },
      },
    );
    const controller = new AbortController();

    await harness.callWithContext({}, controller.signal);

    expect(contexts).toHaveLength(1);
    expect((contexts[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it("omits the context entirely when the browser gave none", async () => {
    let argumentCount = -1;
    const harness = await setup(
      {},
      {
        definition: {
          execute: function (this: unknown, ...args: unknown[]) {
            argumentCount = args.length;
            return RAW;
          },
        },
      },
    );

    await harness.call({ query: "smith" });
    expect(argumentCount).toBe(1);
  });

  it("reports cancellation when the gate call is aborted mid-flight", async () => {
    const controller = new AbortController();
    const harness = await setup({
      gate: () => {
        controller.abort();
        throw abortError();
      },
    });

    const result = await harness.callWithContext({}, controller.signal);

    expect(result).toBe(CANCELLED_MESSAGE);
    expect(harness.order).toEqual(["gate"]);
    expect(harness.events.at(-1)?.detail).toContain("cancelled");
  });

  it("reports cancellation when the site's execute is aborted", async () => {
    const controller = new AbortController();
    const harness = await setup(
      {},
      {
        definition: {
          execute: () => {
            controller.abort();
            throw abortError();
          },
        },
      },
    );

    await expect(harness.callWithContext({}, controller.signal)).resolves.toBe(CANCELLED_MESSAGE);
  });

  it("withholds the raw result when the transform call is aborted", async () => {
    const controller = new AbortController();
    const harness = await setup({
      transform: () => {
        controller.abort();
        throw abortError();
      },
    });

    const result = await harness.callWithContext({}, controller.signal);

    expect(result).toBe(CANCELLED_MESSAGE);
    expect(String(result)).not.toContain(RAW);
  });
});

describe("events", () => {
  it("emits gate → executed → transformed with the server's callId", async () => {
    const harness = await setup({ transform: () => transformResponse("ok") });
    await harness.call({});

    expect(harness.events.map((event) => event.type)).toEqual(["gate", "executed", "transformed"]);
    for (const event of harness.events) {
      expect(event.tool).toBe("search_patients");
      expect(event.callId).toBe("call_1");
      expect(event.verdict).toBe("allow");
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
  });

  it("replays history to a drawer that mounts late, capped at 50", async () => {
    const harness = await setup({ transform: () => transformResponse("ok") });

    for (let index = 0; index < 20; index += 1) await harness.call({});

    const recent = harness.guard.recentEvents();
    expect(harness.events).toHaveLength(60);
    expect(recent).toHaveLength(50);
    // Oldest first: the first ten events fell off the front of the buffer.
    expect(recent[0]).toEqual(harness.events[10]);
    expect(recent.at(-1)).toEqual(harness.events.at(-1));
  });

  it("unsubscribes cleanly and survives a listener that throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await setup({ transform: () => transformResponse("ok") });

    const seen: GuardEvent[] = [];
    const unsubscribe = harness.guard.subscribe(() => {
      throw new Error("drawer render failed");
    });
    harness.guard.subscribe((event) => seen.push(event));

    await expect(harness.call({})).resolves.toBe("ok");
    expect(seen).toHaveLength(3);

    unsubscribe();
    await harness.call({});
    expect(seen).toHaveLength(6);
  });
});

describe("session context", () => {
  it("proceeds without session context when the host getter throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = await setup(
      { transform: () => transformResponse("ok") },
      {
        getSessionContext: () => {
          throw new Error("no session yet");
        },
      },
    );

    await expect(harness.call({})).resolves.toBe("ok");
    expect(harness.fetchStub.gateCalls[0].payload).not.toHaveProperty("sessionContext");
  });

  it("sends only the fields the wire contract allows", async () => {
    const harness = await setup(
      {},
      {
        getSessionContext: () =>
          ({ userId: "u-1", role: "nurse", authToken: "super-secret" }) as never,
      },
    );
    await harness.call({});

    expect(harness.fetchStub.gateCalls[0].payload.sessionContext).toEqual({
      userId: "u-1",
      role: "nurse",
    });
  });

  it("omits an empty session context entirely", async () => {
    const harness = await setup({}, { getSessionContext: () => ({}) });
    await harness.call({});
    expect(harness.fetchStub.gateCalls[0].payload).not.toHaveProperty("sessionContext");
  });
});

describe("wire contract", () => {
  /**
   * The server parses with these exact schemas, and they are `.strict()`: one
   * stray field would 400 every call and fail the whole app closed. Validating
   * the outgoing payloads here catches contract drift in this package's tests
   * rather than in the browser.
   */
  it("sends a gate request the shared schema accepts", async () => {
    defineGlobal("isSecureContext", true);
    defineGlobal("innerWidth", 1280);
    defineGlobal("innerHeight", 800);
    defineGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/151.0.0.0",
      userAgentData: {
        brands: [{ brand: "Chromium", version: "151" }],
        platform: "Linux",
        mobile: false,
      },
    });

    const harness = await setup(
      {},
      { getSessionContext: () => ({ userId: "u-1", role: "front-desk" }) },
    );
    await harness.call({ query: "smith" });

    const parsed = GateRequestSchema.safeParse(harness.fetchStub.gateCalls[0].payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("sends a transform request the shared schema accepts", async () => {
    const harness = await setup();
    await harness.call({ query: "smith" });

    const parsed = TransformRequestSchema.safeParse(harness.fetchStub.transformCalls[0].payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
