import { randomUUID } from "node:crypto";

import {
  DataClassSchema,
  EffectivePolicySchema,
  GateRequestSchema,
  GateResponseSchema,
  GateVerdictSchema,
  GuardStorageError,
  LogRecordSchema,
  LogStatusSchema,
  REVEAL_LOG_APP,
  REVEAL_LOG_TOOL,
  RevealRequestSchema,
  RuleActionSchema,
  RuleMatchSchema,
  TransformRequestSchema,
  TransformResponseSchema,
  type ConfirmationEntry,
  type DataClass,
  type GateRequest,
  type GateVerdict,
  type GuardStorage,
  type JsonObject,
  type LogJustificationVerdict,
  type LogQuery,
  type LogRecord,
  type PerClassTransform,
  type Rule,
  type StatsRange,
} from "@webmcp-guard/shared";
import { z } from "zod";

import { UNAUTHORIZED_MESSAGE, isAdminRequest } from "./auth";
import { buildNameMatcher, classify, orderClasses, type ClassifierOptions } from "./classify";
import { CONFIRMATION_TTL_MS, hashCallArgs, validateConfirmation } from "./confirmation";
import { detokenize } from "./detokenize";
import { jsonError, jsonPayload, parseEnvelope, parseWith, queryObject, truncate } from "./http";
import {
  DEFAULT_JUSTIFICATION_MIN_CHARS,
  heuristicJustificationEvaluator,
  stripJustification,
  type JustificationEvaluation,
  type JustificationEvaluationInput,
  type JustificationEvaluator,
} from "./justification";
import {
  EVALUATOR_FALLBACK_NOTE,
  HUMAN_APPROVED_MESSAGE,
  confirmationMessage,
  confirmationRejectedMessage,
  humanApprovedNote,
  justificationAcceptedNote,
  justificationMessage,
  verdictMessage,
} from "./messages";
import { resolvePolicy, type PolicyDecision } from "./policy-engine";
import { agentInfoFromPosture } from "./posture";
import { seedDefaultPolicy } from "./seed";
import { createTokenizer } from "./tokenize";
import { transformValue } from "./transform";

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

/**
 * Ids reserved by the routing table, so `POST /policies/reorder` and
 * `GET /policies/effective` stay unambiguous. Reserving them also stops a rule
 * from being created that would shadow — or be shadowed by — a route.
 */
export const RESERVED_RULE_IDS = ["reorder", "effective"] as const;

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

/** `GET /policies/effective?app=…&tool=…&tags=read,phi`. */
const EffectiveQueryParamsSchema = z.object({
  app: z.string().min(1).max(120),
  tool: z.string().min(1).max(120),
  /** Comma-separated, matching the `tags` the SDK registered the tool with. */
  tags: z.string().max(500).optional(),
});

/** Default lifetime of a resolved name dictionary, in milliseconds. */
export const NAME_DICTIONARY_TTL_MS = 30_000;

export interface GuardServerConfig {
  /** Where policy, logs and the token vault live. */
  storage: GuardStorage;
  /** HMAC key behind deterministic tokens (`tokenize.ts`). */
  orgSecret: string;
  /** AES-256-GCM key for the token vault (`tokenize.ts`). */
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
  /**
   * Known person names, supplied by the host app, used by the free-text
   * dictionary scan (`docs/04-sdk-requirements.md`: "the portal knows its
   * patient list — a dictionary scan against seeded names is legitimate and
   * effective"). Regexes cannot recognise names; the application can.
   *
   * Called at most once per {@link NAME_DICTIONARY_TTL_MS}, so a name added to
   * the host's database shows up in the scanner within seconds without the
   * guard hammering the callback on every tool call. Throwing is safe: the
   * guard logs a warning and carries on with the other detectors.
   */
  nameDictionary?: () => Promise<readonly string[]> | readonly string[];
  /** Overrides the default `LM-100042`-shaped MRN detector. */
  mrnPattern?: RegExp;
  /** Overrides {@link NAME_DICTIONARY_TTL_MS}. */
  nameDictionaryTtlMs?: number;
  /**
   * Judges the `justification` an agent supplies for a `require-justification`
   * rule (`docs/04-sdk-requirements.md`). Defaults to
   * {@link heuristicJustificationEvaluator}.
   *
   * The seam an LLM evaluator plugs into (Phase 5 stretch, **not built**: see
   * the work log). Whatever is plugged in, the guard treats a throw — or a
   * malformed answer — as evaluator downtime and decides with the heuristic
   * instead, recording the fallback on the audit entry. An evaluator outage
   * must never be able to block every export in the building.
   */
  evaluator?: JustificationEvaluator;
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
  // rather than at the first agent call.
  const orgSecret = requireSecret(config.orgSecret, "orgSecret", "GUARD_ORG_SECRET");
  const vaultKey = requireSecret(config.vaultKey, "vaultKey", "GUARD_VAULT_KEY");
  const adminToken = requireSecret(config.adminToken, "adminToken", "GUARD_ADMIN_TOKEN");

  const storage = config.storage;
  const consoleOrigin = config.consoleOrigin;
  const shouldSeed = config.seed ?? true;
  const tokenizer = createTokenizer({ orgSecret, vaultKey });
  const nameDictionaryTtlMs = config.nameDictionaryTtlMs ?? NAME_DICTIONARY_TTL_MS;

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

  // ---- classifier wiring ---------------------------------------------------

  /**
   * The host's name dictionary, compiled into one matcher and cached for a few
   * seconds. The cache is what makes the callback cheap enough to consult on
   * every single tool call; the TTL is what makes a patient added a minute ago
   * detectable in free text without a restart.
   */
  let nameMatcherCache: { matcher: RegExp | null; expiresAt: number } | null = null;
  let nameMatcherInFlight: Promise<RegExp | null> | null = null;

  async function nameMatcher(): Promise<RegExp | null> {
    if (config.nameDictionary === undefined) return null;

    const now = Date.now();
    if (nameMatcherCache !== null && nameMatcherCache.expiresAt > now) {
      return nameMatcherCache.matcher;
    }
    // Concurrent calls share one trip to the host app.
    if (nameMatcherInFlight !== null) return nameMatcherInFlight;

    nameMatcherInFlight = (async () => {
      let matcher: RegExp | null = null;
      try {
        const names = await config.nameDictionary?.();
        matcher = Array.isArray(names) ? buildNameMatcher(names) : null;
      } catch (error) {
        // The dictionary is one of three passes. Losing it degrades name
        // detection in free text; it must never take the guard down.
        console.warn("[webmcp-guard] nameDictionary threw; continuing without it", error);
        matcher = null;
      }
      nameMatcherCache = { matcher, expiresAt: Date.now() + nameDictionaryTtlMs };
      nameMatcherInFlight = null;
      return matcher;
    })();

    return nameMatcherInFlight;
  }

  async function classifierOptions(): Promise<ClassifierOptions> {
    return {
      ...(config.mrnPattern !== undefined ? { mrnPattern: config.mrnPattern } : {}),
      nameMatcher: await nameMatcher(),
    };
  }

  /** Union of two class lists, in the canonical `DATA_CLASSES` order. */
  function mergeClasses(...lists: readonly DataClass[][]): DataClass[] {
    return orderClasses(lists.flat());
  }

  // ---- justification evaluator --------------------------------------------

  const evaluator = config.evaluator ?? heuristicJustificationEvaluator;

  function isEvaluation(value: unknown): value is JustificationEvaluation {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as { verdict?: unknown; reason?: unknown };
    return (
      (candidate.verdict === "pass" || candidate.verdict === "fail") &&
      typeof candidate.reason === "string"
    );
  }

  /**
   * Runs the configured evaluator, falling back to the heuristic when it throws
   * or answers with something that is not an evaluation.
   *
   * `docs/04`: "Never let evaluator downtime block the demo: on error, fall
   * back to heuristic and log the fallback." The fallback is recorded on the
   * audit entry, not just on the console, so an administrator can tell which
   * decisions their evaluator actually made.
   */
  async function evaluateJustification(
    input: JustificationEvaluationInput,
  ): Promise<{ evaluation: JustificationEvaluation; fellBack: boolean }> {
    if (evaluator === heuristicJustificationEvaluator) {
      return { evaluation: heuristicJustificationEvaluator.evaluate(input), fellBack: false };
    }

    try {
      const answer = (await evaluator.evaluate(input)) as unknown;
      if (isEvaluation(answer)) return { evaluation: answer, fellBack: false };
      console.warn("[webmcp-guard] justification evaluator returned an unusable answer");
    } catch (error) {
      console.warn("[webmcp-guard] justification evaluator threw; using the heuristic", error);
    }

    return { evaluation: heuristicJustificationEvaluator.evaluate(input), fellBack: true };
  }

  /** The minimum length the matched rule asks for, or the shipped default. */
  function justificationMinChars(rule: Rule | null): number {
    if (rule !== null && rule.action.type === "require-justification") {
      return rule.action.minChars ?? DEFAULT_JUSTIFICATION_MIN_CHARS;
    }
    return DEFAULT_JUSTIFICATION_MIN_CHARS;
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
  /**
   * The gate's decision about one call, before anything is written down.
   *
   * It exists because two verdicts are *conversations*, not answers:
   * `require-confirmation` can end as an allow (the person approved) or a deny
   * (the approval was replayed), and `require-justification` can end as an
   * allow (the evaluator passed it) or as another ask. The rest of `/gate` —
   * detokenization, the audit entry, the response — is written once, against
   * this shape, so those two flows cannot each grow their own copy of it.
   */
  interface GateOutcome {
    /** What the agent is told. */
    verdict: GateVerdict;
    /** True when the tool may run: detokenize, log `pending`, return args. */
    allowed: boolean;
    /** Arguments the tool should run on, before detokenization. */
    args: JsonObject;
    /** Agent-legible explanation, for every verdict that needs one. */
    message?: string;
    /** A freshly minted one-time id, on a `require-confirmation`. */
    confirmationId?: string;
    /** Audit-only sentence. Never returned to the agent. */
    auditNote?: string;
    /** What the agent wrote, and what the evaluator made of it. */
    justification?: { text: string; verdict: LogJustificationVerdict };
  }

  /**
   * `require-confirmation`: mint an approval, or spend one.
   *
   * The two halves of the flow (`docs/03-architecture.md` → "the SDK renders an
   * in-page modal the human must approve; the server issues a one-time
   * confirmation id so the approval can't be replayed").
   */
  async function confirmationOutcome(
    gate: GateRequest,
    decision: PolicyDecision,
    callId: string,
    presented: ConfirmationEntry | null,
  ): Promise<GateOutcome> {
    const rule = decision.gateRule;

    if (gate.confirmationId === undefined) {
      const confirmationId = randomUUID();
      const issuedAt = new Date();

      await storage.putConfirmation({
        id: confirmationId,
        app: gate.app,
        tool: gate.tool,
        // Binds the approval to the exact call the human is about to be shown.
        argsHash: hashCallArgs(gate.app, gate.tool, gate.args),
        callId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      });

      return {
        verdict: "require-confirmation",
        allowed: false,
        args: gate.args,
        confirmationId,
        ...(rule !== null ? { message: confirmationMessage(rule) } : {}),
      };
    }

    // `presented` is what `consumeConfirmation` returned — the id is already
    // spent by the time this runs, however this ends.
    const failure = validateConfirmation(presented, gate, Date.now());
    if (failure !== null) {
      return {
        verdict: "deny",
        allowed: false,
        args: gate.args,
        message: confirmationRejectedMessage(failure, gate.tool),
        auditNote: `A confirmation was presented and refused (${failure}).`,
      };
    }

    return {
      verdict: "allow",
      allowed: true,
      args: gate.args,
      message: HUMAN_APPROVED_MESSAGE,
      auditNote: humanApprovedNote(rule, truncate(gate.confirmationId, 64)),
    };
  }

  /** `require-justification`: read it, judge it, and strip it before the tool runs. */
  async function justificationOutcome(
    gate: GateRequest,
    decision: PolicyDecision,
  ): Promise<GateOutcome> {
    const rule = decision.gateRule;
    const minChars = justificationMinChars(rule);

    // Stripped *before* anything else touches the arguments: the justification
    // is guard metadata, so it must never be detokenized, never reach the
    // tool, and never be classified as part of the tool's payload.
    const { args, justification } = stripJustification(gate.args);

    if (justification === null || justification.trim().length === 0) {
      return {
        verdict: "require-justification",
        allowed: false,
        args: gate.args,
        message: justificationMessage(rule, minChars, gate.tool),
      };
    }

    const { evaluation, fellBack } = await evaluateJustification({
      tool: gate.tool,
      args,
      justification,
      context: {
        app: gate.app,
        minChars,
        ...(rule !== null ? { ruleId: rule.id } : {}),
        ...(gate.sessionContext !== undefined ? { session: gate.sessionContext } : {}),
      },
    });

    const fallbackNote = fellBack ? ` ${EVALUATOR_FALLBACK_NOTE}` : "";
    const record = { text: justification, verdict: evaluation };

    if (evaluation.verdict === "fail") {
      return {
        verdict: "require-justification",
        allowed: false,
        args: gate.args,
        message: justificationMessage(rule, minChars, gate.tool, evaluation.reason),
        auditNote: fellBack ? EVALUATOR_FALLBACK_NOTE : undefined,
        justification: record,
      };
    }

    return {
      verdict: "allow",
      allowed: true,
      // The tool runs on the arguments *without* the justification: the
      // portal's schemas are `additionalProperties: false`, and the field was
      // never part of the tool's contract in the first place.
      args,
      auditNote: `${justificationAcceptedNote(evaluation.reason)}${fallbackNote}`,
      justification: record,
    };
  }

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
      // Advisory environment signals; the engine decides what they are worth.
      posture: gate.posture,
    });

    // Every call gets an id, including denied ones: the SDK reports it back and
    // the console can point at one audit row for the whole interaction.
    const callId = randomUUID();

    /**
     * A presented confirmation id is spent **the moment it is presented** —
     * before the hash is compared, before expiry is checked, and whatever the
     * current verdict turns out to be.
     *
     * Burning first is the whole anti-replay property. If validation came
     * first, a failed attempt would leave the id alive, and an attacker who
     * captured one could keep trying different arguments against it until
     * something stuck. This way the first use of an id is the only use, full
     * stop, and a tampered replay destroys the approval it was trying to
     * subvert.
     */
    const presented =
      gate.confirmationId === undefined
        ? null
        : await storage.consumeConfirmation(gate.confirmationId);

    let outcome: GateOutcome;
    if (decision.verdict === "require-confirmation") {
      outcome = await confirmationOutcome(gate, decision, callId, presented);
    } else if (decision.verdict === "require-justification") {
      outcome = await justificationOutcome(gate, decision);
    } else {
      const message = verdictMessage(decision, gate.tool);
      outcome = {
        verdict: decision.verdict,
        allowed: decision.verdict === "allow",
        args: gate.args,
        ...(message !== undefined ? { message } : {}),
        // A stale id (the policy changed under a pending approval) is spent all
        // the same — it was consumed above — and the audit trail says so.
        ...(gate.confirmationId !== undefined
          ? {
              auditNote:
                "A confirmation id was presented for a call that no longer requires " +
                "confirmation. It was spent, not honoured.",
            }
          : {}),
      };
    }

    /**
     * Inbound transform: tokens in the agent's arguments become real values,
     * but **only after the call has been allowed**. A denied or
     * pending-confirmation call never gets so much as one value out of the
     * vault, so the gate cannot be used as a detokenization oracle by calling a
     * tool the caller knows will be blocked.
     */
    let executableArgs = outcome.args;
    let inboundClasses: DataClass[] = [];
    /** Set when the gate swapped tokens for real values, for the audit trail. */
    let detokenizeNote: string | undefined;

    if (outcome.allowed) {
      const detokenized = await detokenize(outcome.args, async (token) => {
        const entry = await storage.getVaultEntry(token);
        return entry === null ? null : tokenizer.open(entry);
      });
      executableArgs = detokenized.value;

      if (detokenized.replaced.length > 0) {
        const unresolved =
          detokenized.unresolved.length > 0
            ? ` ${detokenized.unresolved.length} token(s) were not in the vault and were left as they arrived.`
            : "";
        detokenizeNote =
          `Detokenized ${detokenized.replaced.length} argument value(s) from the vault ` +
          `(${detokenized.replaced.map((token) => truncate(token, 40)).join(", ")}) before running the tool.${unresolved}`;
      }

      // Classified *after* substitution: what matters for the audit trail is
      // the PHI the site is about to be handed, which is also what makes
      // `add_visit_note` scannable on the way in (docs/05).
      inboundClasses = classify(executableArgs, await classifierOptions()).classes;
    }

    const auditMessage = [outcome.message, outcome.auditNote, detokenizeNote]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" ");

    await storage.appendLog(
      LogRecordSchema.parse({
        id: callId,
        timestamp: new Date().toISOString(),
        app: gate.app,
        tool: gate.tool,
        verdict: outcome.verdict,
        agent: agentInfoFromPosture(gate.posture),
        session: gate.sessionContext,
        dataClasses: inboundClasses,
        ruleIds: decision.ruleIds,
        durationMs: 0,
        payloads: {
          // As received (justification, tokens and all) versus what the tool
          // actually runs on. The audit trail keeps what the agent sent even
          // when the pipeline strips it.
          argsBefore: gate.args,
          argsAfter: executableArgs,
        },
        ...(outcome.justification !== undefined
          ? {
              justification: outcome.justification.text,
              justificationVerdict: outcome.justification.verdict,
            }
          : {}),
        ...(auditMessage.length > 0 ? { message: auditMessage } : {}),
        // An allowed call is still in flight; anything else ended right here.
        status: outcome.allowed ? "pending" : "complete",
      } satisfies LogRecord),
    );

    return jsonPayload(
      GateResponseSchema.parse({
        callId,
        verdict: outcome.verdict,
        ...(outcome.allowed ? { args: executableArgs } : {}),
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        ...(outcome.confirmationId !== undefined ? { confirmationId: outcome.confirmationId } : {}),
        ruleIds: decision.ruleIds,
      }),
      200,
      cors,
    );
  }

  /**
   * `GET /policies/effective` — **not admin-gated**, on purpose.
   *
   * The SDK needs it before it can register a tool, from the page, with no
   * credentials but the host app's own session — the same trust position
   * `/gate` occupies (see the note above `handleGate`). So it answers with the
   * smallest thing that lets a client shape an input schema: two booleans and a
   * number. No rule ids, no rule names, no messages, no matchers, nothing about
   * rules that did *not* match. Someone who can call this learns "this tool
   * wants a justification of at least 40 characters" — which is exactly what
   * the tool's own schema is about to tell every agent anyway.
   */
  async function handleEffectivePolicy(
    request: Request,
    cors: Record<string, string>,
  ): Promise<Response> {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed(["GET"], cors);

    const url = new URL(request.url);
    const parsed = parseWith(
      EffectiveQueryParamsSchema,
      queryObject(url),
      "effective policy query",
      cors,
    );
    if (!parsed.ok) return parsed.response;

    const { app, tool, tags } = parsed.value;
    const toolTags =
      tags === undefined
        ? undefined
        : tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

    const policy = await storage.getPolicy();
    // No posture on this path: registration happens before any call, and a
    // posture rule that would deny the *call* has no bearing on the *schema*.
    const decision = resolvePolicy(policy, {
      app,
      tool,
      ...(toolTags !== undefined && toolTags.length > 0 ? { toolTags } : {}),
    });

    const requiresJustification = decision.verdict === "require-justification";

    return jsonPayload(
      EffectivePolicySchema.parse({
        requiresJustification,
        minChars: requiresJustification ? justificationMinChars(decision.gateRule) : null,
        requiresConfirmation: decision.verdict === "require-confirmation",
        // Reserved: the policy model has no `disabled` verdict yet.
        disabled: false,
      }),
      200,
      cors,
    );
  }

  /**
   * Re-resolves the transform aspect for a call that has already been gated.
   *
   * The *matching* was done at the gate (only that half of the wire carries the
   * tool's tags), but the rule bodies are read again here, live. That is what
   * makes the console's "edit a policy, see the next call behave differently,
   * no redeploy" claim literally true — including for a call that is already in
   * flight. A rule that was disabled or deleted in the meantime stops applying.
   */
  async function transformAspect(
    ruleIds: string[],
  ): Promise<{ ruleIds: string[]; perClass: PerClassTransform | null }> {
    if (ruleIds.length === 0) return { ruleIds: [], perClass: null };

    const rules = await storage.listRules();
    const byId = new Map(rules.map((rule) => [rule.id, rule]));

    const matched = ruleIds
      .map((id) => byId.get(id))
      .filter((rule): rule is Rule => rule !== undefined && rule.enabled)
      .filter((rule) => rule.action.type === "transform");

    const first = matched[0];
    return {
      ruleIds: matched.map((rule) => rule.id),
      perClass:
        first !== undefined && first.action.type === "transform" ? first.action.perClass : null,
    };
  }

  async function handleTransform(
    request: Request,
    cors: Record<string, string>,
  ): Promise<Response> {
    const parsed = await parseEnvelope(request, TransformRequestSchema, cors);
    if (!parsed.ok) return parsed.response;
    const { app, tool, callId, result } = parsed.value;

    const finishedAt = Date.now();
    const classifier = await classifierOptions();

    let ruleIds: string[] = [];
    let perClass: PerClassTransform | null = null;
    let pending: LogRecord | null = null;

    if (callId !== undefined) {
      const candidate = await storage.getLog(callId);
      // The entry must be the still-open half of *this* call: same app, same
      // tool. A callId that points at someone else's entry is treated as no
      // match at all rather than being allowed to overwrite it.
      if (
        candidate !== null &&
        candidate.status === "pending" &&
        candidate.app === app &&
        candidate.tool === tool
      ) {
        pending = candidate;
        const aspect = await transformAspect(candidate.ruleIds);
        ruleIds = aspect.ruleIds;
        perClass = aspect.perClass;
      }
    }

    let orphanDecisionRuleIds: string[] = [];
    /** True when a concurrent transform closed this audit entry first. */
    let lostRace = false;

    if (pending === null) {
      // Unknown, mismatched or already-completed callId. The tool has already
      // run at this point, so failing the request would only cost the agent its
      // result without un-doing anything: transform it, log the anomaly, answer.
      const policy = await storage.getPolicy();
      // No tags are available on this half of the wire, so a tag-scoped rule
      // cannot match here — one more reason the gate is the authoritative half.
      const decision = resolvePolicy(policy, { app, tool });
      orphanDecisionRuleIds = decision.ruleIds;
      ruleIds = decision.transformRule === null ? [] : [decision.transformRule.id];
      perClass = decision.perClass;
    }

    const outcome = transformValue(result, { perClass, tokenizer, classifier });

    // The vault is written before the tokens leave the building: a token the
    // agent holds must always be one `/gate` can reverse.
    for (const entry of outcome.vaultEntries) await storage.putVaultEntry(entry);

    if (pending !== null) {
      const startedAt = Date.parse(pending.timestamp);
      const completed = await storage.completeLog(callId as string, {
        durationMs: Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : 0,
        // Inbound classes (found in the args at the gate) plus outbound ones.
        dataClasses: mergeClasses(pending.dataClasses, outcome.classesFound),
        payloads: { resultBefore: result, resultAfter: outcome.result },
      });

      // `completeLog` is single-shot; a lost race means someone else closed this
      // entry between the read and the write. Recording it is better than
      // silently dropping the second half of the call.
      if (completed === null) {
        pending = null;
        lostRace = true;
      }
    }

    if (pending === null) {
      const reference = callId === undefined ? "" : ` (callId ${truncate(callId, 64)})`;
      const anomaly = lostRace
        ? `Transform raced another transform for the same call${reference} and lost; that audit entry was already closed. The result was transformed and logged here instead.`
        : `Transform received without a matching pending gate call${reference}. The result was logged but never gated.`;
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
          dataClasses: outcome.classesFound,
          ruleIds: orphanDecisionRuleIds,
          durationMs: 0,
          payloads: { resultBefore: result, resultAfter: outcome.result },
          message: anomaly,
          status: "complete",
        } satisfies LogRecord),
      );
    }

    return jsonPayload(
      TransformResponseSchema.parse({
        result: outcome.result,
        classesFound: outcome.classesFound,
        ruleIds,
      }),
      200,
      cors,
    );
  }

  // ---- token reveal (console) ---------------------------------------------

  /**
   * Writes the audit entry that makes a reveal accountable
   * (`docs/06-console-requirements.md` §1: "admin-token gated, **and revealing
   * is itself logged**").
   *
   * Called *before* the value is returned, so a failure to record the reveal
   * fails the reveal. The entry names what was revealed and never contains the
   * revealed value — an audit log that copies the plaintext it is auditing
   * would defeat the vault.
   */
  async function logReveal(message: string): Promise<void> {
    await storage.appendLog(
      LogRecordSchema.parse({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        app: REVEAL_LOG_APP,
        tool: REVEAL_LOG_TOOL,
        verdict: "allow",
        agent: {},
        dataClasses: [],
        ruleIds: [],
        durationMs: 0,
        payloads: {},
        message,
        status: "complete",
      } satisfies LogRecord),
    );
  }

  async function handleReveal(request: Request, cors: Record<string, string>): Promise<Response> {
    if (request.method.toUpperCase() !== "POST") return methodNotAllowed(["POST"], cors);

    const parsed = await parseEnvelope(request, RevealRequestSchema, cors);
    if (!parsed.ok) return parsed.response;
    const { token, logId } = parsed.value;

    if (token !== undefined) {
      const entry = await storage.getVaultEntry(token);
      if (entry === null) {
        return jsonError(
          404,
          "not_found",
          `No vault entry for token "${truncate(token, 64)}". Unknown tokens are never invented — this one was not minted by this deployment.`,
          cors,
        );
      }

      const value = tokenizer.open(entry);
      if (value === null) {
        return jsonError(
          500,
          "internal_error",
          `The vault entry for "${truncate(token, 64)}" could not be decrypted. It was written with a different GUARD_VAULT_KEY, or it has been altered.`,
          cors,
        );
      }

      await logReveal(
        `Console administrator revealed the value behind ${truncate(entry.token, 64)} (${entry.dataClass}).`,
      );

      return jsonPayload({ token: entry.token, dataClass: entry.dataClass, value }, 200, cors);
    }

    const id = logId as string;
    const record = await storage.getLog(id);
    if (record === null) {
      return jsonError(404, "not_found", `No log entry with id "${truncate(id, 64)}".`, cors);
    }

    await logReveal(
      `Console administrator revealed the stored before/after payloads of audit entry ${truncate(record.id, 64)} (${truncate(record.tool, 64)}).`,
    );

    return jsonPayload({ logId: record.id, acknowledged: true }, 200, cors);
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

    // Reachable by the page, like /gate — and therefore matched *before* the
    // admin-token check below. "effective" is a reserved rule id, so this can
    // never shadow (or be shadowed by) a real `GET /policies/:id`.
    if (first === "policies" && second === "effective") {
      return handleEffectivePolicy(request, cors);
    }

    // Everything below is the console's API and needs the admin token.
    if (first === "policies" || first === "logs" || first === "stats" || first === "tokens") {
      if (!isAdminRequest(request, adminToken)) return unauthorized(cors);

      if (first === "policies") return handlePolicies(request, second, cors);
      if (first === "logs") return handleLogs(request, second, cors);
      if (first === "tokens") {
        if (second === "reveal") return handleReveal(request, cors);
        return notFound(path, cors);
      }
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
