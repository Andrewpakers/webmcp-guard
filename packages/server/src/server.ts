import { randomUUID } from "node:crypto";

import {
  DataClassSchema,
  GateRequestSchema,
  GateResponseSchema,
  GateVerdictSchema,
  GuardStorageError,
  LogRecordSchema,
  LogStatusSchema,
  RuleActionSchema,
  RuleMatchSchema,
  TransformRequestSchema,
  TransformResponseSchema,
  type GuardStorage,
  type LogQuery,
  type LogRecord,
  type StatsRange,
} from "@webmcp-guard/shared";
import { z } from "zod";

import { UNAUTHORIZED_MESSAGE, isAdminRequest } from "./auth";
import { jsonError, jsonPayload, parseEnvelope, parseWith, queryObject, truncate } from "./http";
import { verdictMessage } from "./messages";
import { resolvePolicy } from "./policy-engine";
import { agentInfoFromPosture } from "./posture";
import { seedDefaultPolicy } from "./seed";

/**
 * `createGuardServer` — the Node half of WebMCP Guard
 * (`docs/04-sdk-requirements.md` → "Package: @webmcp-guard/server").
 *
 * It returns a framework-agnostic `handle(request, segments)` plus a Next.js
 * App Router adapter, so the same enforcement code can be mounted anywhere:
 *
 * ```ts
 * // apps/portal/app/api/guard/[...route]/route.ts
 * const guard = createGuardServer({ storage: sqliteStorage({ path }), ... });
 * export const { GET, POST, PUT, DELETE, OPTIONS } = guard.nextHandler();
 * ```
 */

/** Ids reserved by the routing table, so `PUT /policies/reorder` stays unambiguous. */
export const RESERVED_RULE_IDS = ["reorder"] as const;

const RuleIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "Rule ids are 1-64 characters of letters, digits, dot, dash or underscore.",
  );

const RuleNameSchema = z.string().trim().min(1).max(120);

const CreateRuleSchema = z
  .object({
    id: RuleIdSchema.optional(),
    name: RuleNameSchema,
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    match: RuleMatchSchema,
    action: RuleActionSchema,
  })
  .strict();

const UpdateRuleSchema = z
  .object({
    name: RuleNameSchema.optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    match: RuleMatchSchema.optional(),
    action: RuleActionSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one field to update.",
  });

const ReorderSchema = z.object({ ids: z.array(RuleIdSchema).min(1) }).strict();

const DefaultActionSchema = z.object({ defaultAction: z.enum(["allow", "deny"]) }).strict();

/** Accepts `2026-08-29` or a full ISO timestamp; both compare correctly as strings. */
const IsoTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/,
    "Expected an ISO-8601 date or timestamp, e.g. 2026-08-29 or 2026-08-29T12:00:00.000Z.",
  );

/**
 * Query parameters are parsed leniently (unknown keys are dropped, not
 * rejected) so a cache-busting `?_=123` from the console never turns into a
 * 400. Request *bodies* are strict.
 */
const LogQueryParamsSchema = z.object({
  app: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  verdict: GateVerdictSchema.optional(),
  dataClass: DataClassSchema.optional(),
  agent: z.string().min(1).optional(),
  status: LogStatusSchema.optional(),
  since: IsoTimeSchema.optional(),
  until: IsoTimeSchema.optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
});

const StatsQueryParamsSchema = z.object({
  since: IsoTimeSchema.optional(),
  until: IsoTimeSchema.optional(),
});

export interface GuardServerConfig {
  /** Where policy, logs and the token vault live. */
  storage: GuardStorage;
  /** HMAC key behind deterministic tokens. Consumed by the Phase 3 tokenizer. */
  orgSecret: string;
  /** AES-256-GCM key for the token vault. Consumed by the Phase 3 vault. */
  vaultKey: string;
  /** Bearer token for the console-facing admin routes. */
  adminToken: string;
  /**
   * Exact origin allowed to call the admin routes cross-origin (the console,
   * `GUARD_CONSOLE_ORIGIN`). Omit for same-origin-only deployments — there is
   * no wildcard mode on purpose.
   */
  consoleOrigin?: string;
  /** Set `false` for a host app that manages policy itself. Defaults to `true`. */
  seed?: boolean;
}

/** The four Next.js App Router verbs, plus the preflight handler. */
export interface NextRouteHandlers {
  GET: NextRouteHandler;
  POST: NextRouteHandler;
  PUT: NextRouteHandler;
  DELETE: NextRouteHandler;
  OPTIONS: NextRouteHandler;
}

/**
 * Next 15 hands route params in as a promise; older versions passed the object
 * directly. Both are accepted.
 */
export interface NextRouteContext {
  params?: Promise<NextRouteParams> | NextRouteParams;
}

export type NextRouteParams = Record<string, string | string[] | undefined>;

export type NextRouteHandler = (request: Request, context?: NextRouteContext) => Promise<Response>;

export interface GuardServer {
  /** Applies storage migrations and seeds the default policy. Idempotent. */
  ready(): Promise<void>;
  /** Framework-agnostic entry point. `segments` is the path below the mount. */
  handle(request: Request, segments: string[]): Promise<Response>;
  /** Next.js App Router adapter for `app/api/guard/[...route]/route.ts`. */
  nextHandler(): NextRouteHandlers;
}

function requireSecret(value: unknown, field: string, envVar: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(
      `createGuardServer: "${field}" must be a non-empty string (set ${envVar} in the environment).`,
    );
  }
  return value;
}

export function createGuardServer(config: GuardServerConfig): GuardServer {
  if (config.storage === undefined || config.storage === null) {
    throw new TypeError('createGuardServer: "storage" is required.');
  }

  // Validated at construction so a misconfigured deployment fails at boot
  // rather than at the first agent call. `orgSecret`/`vaultKey` are read from
  // `config` by the Phase 3 tokenizer and vault.
  requireSecret(config.orgSecret, "orgSecret", "GUARD_ORG_SECRET");
  requireSecret(config.vaultKey, "vaultKey", "GUARD_VAULT_KEY");
  const adminToken = requireSecret(config.adminToken, "adminToken", "GUARD_ADMIN_TOKEN");

  const storage = config.storage;
  const consoleOrigin = config.consoleOrigin;
  const shouldSeed = config.seed ?? true;

  let readyPromise: Promise<void> | null = null;

  function ready(): Promise<void> {
    // Memoised so concurrent requests share one initialisation.
    readyPromise ??= (async () => {
      await storage.init();
      if (shouldSeed) await seedDefaultPolicy(storage);
    })();
    return readyPromise;
  }

  /**
   * CORS for the console, which is deployed on a different origin
   * (`docs/03-architecture.md`: console on Vercel, portal on Render). Only the
   * one configured origin is ever echoed back, never `*`, and credentials are
   * never allowed — the console authenticates with a bearer token, not cookies.
   */
  function corsHeaders(request: Request): Record<string, string> {
    if (consoleOrigin === undefined) return {};
    const origin = request.headers.get("origin");
    if (origin === null || origin !== consoleOrigin) return { Vary: "Origin" };
    return {
      "Access-Control-Allow-Origin": consoleOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  function notFound(segments: string[], cors: Record<string, string>): Response {
    const path = segments.map((segment) => truncate(segment, 40)).join("/");
    return jsonError(404, "not_found", `No WebMCP Guard endpoint at "/${path}".`, cors);
  }

  function methodNotAllowed(allowed: string[], cors: Record<string, string>): Response {
    return jsonError(
      405,
      "method_not_allowed",
      `This WebMCP Guard endpoint accepts ${allowed.join(", ")}.`,
      { ...cors, Allow: allowed.join(", ") },
    );
  }

  function unauthorized(cors: Record<string, string>): Response {
    return jsonError(401, "unauthorized", UNAUTHORIZED_MESSAGE, cors);
  }

  function storageErrorResponse(error: GuardStorageError, cors: Record<string, string>): Response {
    return error.code === "duplicate-rule"
      ? jsonError(409, "conflict", error.message, cors)
      : jsonError(400, "bad_request", error.message, cors);
  }

  // ---- agent-facing routes -------------------------------------------------

  /**
   * `POST /gate` and `POST /transform` carry **no WebMCP Guard authentication**,
   * by design.
   *
   * They are mounted inside the host application and are reachable by exactly
   * whoever can already reach the page: the host app's own session protects
   * them in production, the same way it protects the app's data APIs. WebMCP
   * Guard governs the *agent channel* — it is not a boundary against the human
   * at the keyboard, who already has the data in the DOM
   * (`docs/03-architecture.md` → threat model). Nothing in this repo may
   * describe these two routes as authenticated.
   */
  async function handleGate(request: Request, cors: Record<string, string>): Promise<Response> {
    const parsed = await parseEnvelope(request, GateRequestSchema, cors);
    if (!parsed.ok) return parsed.response;
    const gate = parsed.value;

    const policy = await storage.getPolicy();
    const decision = resolvePolicy(policy, {
      app: gate.app,
      tool: gate.tool,
      toolTags: gate.toolTags,
      role: gate.sessionContext?.role,
    });

    // Every call gets an id, including denied ones: the SDK reports it back and
    // the console can point at one audit row for the whole interaction.
    const callId = randomUUID();
    const message = verdictMessage(decision, gate.tool);
    const allowed = decision.verdict === "allow";

    await storage.appendLog(
      LogRecordSchema.parse({
        id: callId,
        timestamp: new Date().toISOString(),
        app: gate.app,
        tool: gate.tool,
        verdict: decision.verdict,
        agent: agentInfoFromPosture(gate.posture),
        session: gate.sessionContext,
        dataClasses: [],
        ruleIds: decision.ruleIds,
        durationMs: 0,
        payloads: {
          argsBefore: gate.args,
          // Phase 3 replaces this with the detokenized args the site executes.
          argsAfter: gate.args,
        },
        message,
        // An allowed call is still in flight; anything else ended right here.
        status: allowed ? "pending" : "complete",
      } satisfies LogRecord),
    );

    return jsonPayload(
      GateResponseSchema.parse({
        callId,
        verdict: decision.verdict,
        // Phase 3 substitutes real values for the tokens in these args.
        ...(allowed ? { args: gate.args } : {}),
        ...(message !== undefined ? { message } : {}),
        ruleIds: decision.ruleIds,
      }),
      200,
      cors,
    );
  }

  /** Which of the rules that matched at the gate were transform rules. */
  async function transformRuleIds(ruleIds: string[]): Promise<string[]> {
    if (ruleIds.length === 0) return [];
    const rules = await storage.listRules();
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return ruleIds.filter((id) => byId.get(id)?.action.type === "transform");
  }

  async function handleTransform(
    request: Request,
    cors: Record<string, string>,
  ): Promise<Response> {
    const parsed = await parseEnvelope(request, TransformRequestSchema, cors);
    if (!parsed.ok) return parsed.response;
    const { app, tool, callId, result } = parsed.value;

    const finishedAt = Date.now();
    let ruleIds: string[] = [];
    let completed: LogRecord | null = null;

    if (callId !== undefined) {
      const pending = await storage.getLog(callId);
      // The entry must be the still-open half of *this* call: same app, same
      // tool. A callId that points at someone else's entry is treated as no
      // match at all rather than being allowed to overwrite it.
      if (
        pending !== null &&
        pending.status === "pending" &&
        pending.app === app &&
        pending.tool === tool
      ) {
        ruleIds = await transformRuleIds(pending.ruleIds);
        const startedAt = Date.parse(pending.timestamp);
        completed = await storage.completeLog(callId, {
          durationMs: Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : 0,
          // Phase 3 fills this in from the classifier.
          dataClasses: [],
          payloads: {
            resultBefore: result,
            // Phase 3 returns the transformed copy here instead.
            resultAfter: result,
          },
        });
      }
    }

    if (completed === null) {
      // Unknown, mismatched or already-completed callId. The tool has already
      // run at this point, so failing the request would only cost the agent its
      // result without un-doing anything: log the anomaly and answer.
      const policy = await storage.getPolicy();
      // No tags are available on this half of the wire, so a tag-scoped rule
      // cannot match here — one more reason the gate is the authoritative half.
      const decision = resolvePolicy(policy, { app, tool });
      ruleIds = decision.transformRule === null ? [] : [decision.transformRule.id];

      const reference = callId === undefined ? "" : ` (callId ${truncate(callId, 64)})`;
      await storage.appendLog(
        LogRecordSchema.parse({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          app,
          tool,
          // The call was never gated; this row records that it happened, and the
          // message says so rather than claiming a policy allowed it.
          verdict: "allow",
          agent: {},
          dataClasses: [],
          ruleIds: decision.ruleIds,
          durationMs: 0,
          payloads: { resultBefore: result, resultAfter: result },
          message: `Transform received without a matching pending gate call${reference}. The result was logged but never gated.`,
          status: "complete",
        } satisfies LogRecord),
      );
    }

    return jsonPayload(
      TransformResponseSchema.parse({
        // Phase 2 is a logging passthrough: classification and the per-class
        // transforms land in Phase 3.
        result,
        classesFound: [],
        ruleIds,
      }),
      200,
      cors,
    );
  }

  // ---- admin routes --------------------------------------------------------

  async function handlePolicies(
    request: Request,
    second: string | undefined,
    cors: Record<string, string>,
  ): Promise<Response> {
    const method = request.method.toUpperCase();

    if (second === undefined) {
      if (method === "GET") return jsonPayload(await storage.getPolicy(), 200, cors);

      if (method === "POST") {
        const parsed = await parseEnvelope(request, CreateRuleSchema, cors);
        if (!parsed.ok) return parsed.response;
        const draft = parsed.value;

        if (draft.id !== undefined && (RESERVED_RULE_IDS as readonly string[]).includes(draft.id)) {
          return jsonError(
            400,
            "bad_request",
            `"${draft.id}" is reserved by the policy API and cannot be a rule id.`,
            cors,
          );
        }

        try {
          return jsonPayload(await storage.createRule(draft), 201, cors);
        } catch (error) {
          if (error instanceof GuardStorageError) return storageErrorResponse(error, cors);
          throw error;
        }
      }

      if (method === "PUT") {
        const parsed = await parseEnvelope(request, DefaultActionSchema, cors);
        if (!parsed.ok) return parsed.response;
        await storage.setDefaultAction(parsed.value.defaultAction);
        return jsonPayload(await storage.getPolicy(), 200, cors);
      }

      return methodNotAllowed(["GET", "POST", "PUT"], cors);
    }

    if (second === "reorder") {
      if (method !== "POST") return methodNotAllowed(["POST"], cors);
      const parsed = await parseEnvelope(request, ReorderSchema, cors);
      if (!parsed.ok) return parsed.response;

      try {
        await storage.reorderRules(parsed.value.ids);
      } catch (error) {
        if (error instanceof GuardStorageError) return storageErrorResponse(error, cors);
        throw error;
      }
      return jsonPayload(await storage.getPolicy(), 200, cors);
    }

    const id = parseWith(RuleIdSchema, second, "rule id", cors);
    if (!id.ok) return id.response;

    if (method === "PUT") {
      const parsed = await parseEnvelope(request, UpdateRuleSchema, cors);
      if (!parsed.ok) return parsed.response;

      const updated = await storage.updateRule(id.value, parsed.value);
      if (updated === null) {
        return jsonError(404, "not_found", `No policy rule with id "${id.value}".`, cors);
      }
      return jsonPayload(updated, 200, cors);
    }

    if (method === "DELETE") {
      const deleted = await storage.deleteRule(id.value);
      if (!deleted) {
        return jsonError(404, "not_found", `No policy rule with id "${id.value}".`, cors);
      }
      return jsonPayload({ id: id.value, deleted: true }, 200, cors);
    }

    if (method === "GET") {
      const rule = await storage.getRule(id.value);
      if (rule === null) {
        return jsonError(404, "not_found", `No policy rule with id "${id.value}".`, cors);
      }
      return jsonPayload(rule, 200, cors);
    }

    return methodNotAllowed(["GET", "PUT", "DELETE"], cors);
  }

  async function handleLogs(
    request: Request,
    second: string | undefined,
    cors: Record<string, string>,
  ): Promise<Response> {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed(["GET"], cors);

    if (second !== undefined) {
      const entry = await storage.getLog(second);
      if (entry === null) {
        return jsonError(404, "not_found", `No log entry with id "${truncate(second, 64)}".`, cors);
      }
      return jsonPayload(entry, 200, cors);
    }

    const url = new URL(request.url);
    const parsed = parseWith(LogQueryParamsSchema, queryObject(url), "log filters", cors);
    if (!parsed.ok) return parsed.response;

    const params = parsed.value;
    const query: LogQuery = {
      ...(params.app !== undefined ? { app: params.app } : {}),
      ...(params.tool !== undefined ? { tool: params.tool } : {}),
      ...(params.verdict !== undefined ? { verdict: params.verdict } : {}),
      ...(params.dataClass !== undefined ? { dataClass: params.dataClass } : {}),
      ...(params.agent !== undefined ? { agentId: params.agent } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.since !== undefined ? { since: params.since } : {}),
      ...(params.until !== undefined ? { until: params.until } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    };

    return jsonPayload(await storage.queryLogs(query), 200, cors);
  }

  async function handleStats(request: Request, cors: Record<string, string>): Promise<Response> {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed(["GET"], cors);

    const url = new URL(request.url);
    const parsed = parseWith(StatsQueryParamsSchema, queryObject(url), "stats range", cors);
    if (!parsed.ok) return parsed.response;

    const range: StatsRange = {
      ...(parsed.value.since !== undefined ? { since: parsed.value.since } : {}),
      ...(parsed.value.until !== undefined ? { until: parsed.value.until } : {}),
    };

    return jsonPayload(await storage.stats(range), 200, cors);
  }

  async function route(
    request: Request,
    segments: string[],
    cors: Record<string, string>,
  ): Promise<Response> {
    const path = segments.filter((segment) => segment.length > 0);
    const [first, second, ...extra] = path;
    const method = request.method.toUpperCase();

    if (extra.length > 0) return notFound(path, cors);

    if (first === "gate" && second === undefined) {
      return method === "POST" ? handleGate(request, cors) : methodNotAllowed(["POST"], cors);
    }

    if (first === "transform" && second === undefined) {
      return method === "POST" ? handleTransform(request, cors) : methodNotAllowed(["POST"], cors);
    }

    // Everything below is the console's API and needs the admin token.
    if (first === "policies" || first === "logs" || first === "stats") {
      if (!isAdminRequest(request, adminToken)) return unauthorized(cors);

      if (first === "policies") return handlePolicies(request, second, cors);
      if (first === "logs") return handleLogs(request, second, cors);
      if (second === undefined) return handleStats(request, cors);
    }

    return notFound(path, cors);
  }

  async function handle(request: Request, segments: string[]): Promise<Response> {
    const cors = corsHeaders(request);

    if (request.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      await ready();
      return await route(request, segments, cors);
    } catch (error) {
      // Internals never reach the caller: an agent gets a sentence it can act
      // on, and the operator gets the stack in the server log.
      console.error("[webmcp-guard] request failed", error);
      return jsonError(
        500,
        "internal_error",
        "WebMCP Guard could not complete this request. Try again; if it keeps failing, tell the person you are working with that the guard service is erroring.",
        cors,
      );
    }
  }

  async function segmentsFrom(context?: NextRouteContext): Promise<string[]> {
    // Next 15 passes `params` as a promise; earlier versions passed the object.
    const params = context?.params === undefined ? undefined : await context.params;
    if (params === undefined) return [];

    const catchAll = params.route ?? Object.values(params).find((value) => Array.isArray(value));
    if (Array.isArray(catchAll)) return catchAll.map((segment) => String(segment));
    if (typeof catchAll === "string") return [catchAll];
    return [];
  }

  function nextHandler(): NextRouteHandlers {
    const adapter: NextRouteHandler = async (request, context) =>
      handle(request, await segmentsFrom(context));

    return { GET: adapter, POST: adapter, PUT: adapter, DELETE: adapter, OPTIONS: adapter };
  }

  return { ready, handle, nextHandler };
}
