# 04 — SDK Requirements

The SDK is the product. It must read as a generic, documentable library that
any Node/React shop could adopt — the healthcare portal is just its first
customer. Everything below is TypeScript.

## Package: `@webmcp-guard/sdk` (browser)

### Public API

```ts
import { createGuard } from "@webmcp-guard/sdk";

const guard = createGuard({
  endpoint: "/api/guard",      // where @webmcp-guard/server is mounted
  app: "lakeside-portal",          // app identifier for policy scoping
  getSessionContext: () => ({      // host app supplies identity context
    userId, role,                  // used for role-scoped policies (Phase 6)
  }),
  onBlocked: (info) => { ... },    // optional UI hook (toast, etc.)
});

// Drop-in replacement for document.modelContext.registerTool:
await guard.registerTool({
  name: "search_patients",
  description: "...",
  inputSchema: { ... },
  tags: ["read", "phi"],           // WebMCP Guard extension: policy matching hooks
  execute: async (input) => { ... },
}, { signal });                     // AbortSignal passthrough for unregistration
```

### Required behaviors

1. **Registration wrapping.** Internally calls
   `document.modelContext.registerTool` (fallback `navigator.modelContext`)
   with a wrapped `execute`. The literal `document.modelContext.registerTool(`
   call must be plainly visible in the source (challenge requirement).
2. **Graceful degradation.** No WebMCP → warn once, expose
   `guard.available === false`, never throw at import or registration time.
3. **Schema rewriting from policy.** On registration the SDK fetches effective
   policy for the tool and:
   - injects a required `justification: string` input property when policy says
     `require-justification` (description tells the agent why and what a good
     justification contains);
   - sets `annotations.readOnlyHint` / `annotations.untrustedContentHint` from
     the tool's tags/policy;
   - if policy verdict for the tool is `disabled`, does not register it at all
     (and unregisters via AbortController if policy changes later — listen for
     policy updates via periodic refetch; a `toolchange` listener plus refresh
     button is fine, no websockets needed).
4. **Execute pipeline.** Wrapped execute performs, in order: gate call to the
   server (posture snapshot + args) → on `deny`, return a structured,
   agent-legible error string explaining the denial and how to proceed (e.g.
   "blocked by policy P-7: destructive actions require justification") → on
   `require-confirmation`, render an in-page modal, resolve only on human
   approval, include the one-time confirmation id in the follow-up gate call →
   on `allow`, run the site's original `execute` with the **detokenized** args
   returned by the gate → send the result for transform → return the
   transformed result to the agent. Honor the incoming `AbortSignal` end to
   end.
5. **Posture snapshot.** Collect and send: `navigator.userAgentData`
   (brands/versions/platform, with UA-string fallback parsing),
   `isSecureContext`, viewport, timestamp, and a best-effort agent guess
   (e.g. ChatGPT in-app browser UA markers). Never claim these are strong
   signals — the server decides, the client just reports.
6. **Errors are content.** Anything the agent sees back must be a clear string
   the model can act on. No stack traces, no JSON blobs of internal state.

### React helper (nice-to-have, small)

`useGuardTool(toolDef, deps)` — registers on mount, aborts on unmount.
Mirrors the community `usewebmcp` hook shape so it feels idiomatic.

## Package: `@webmcp-guard/server` (Node)

Factory that returns framework-agnostic handlers plus a Next.js adapter:

```ts
import { createGuardServer } from "@webmcp-guard/server";
import { sqliteStorage } from "@webmcp-guard/storage-sqlite";

const guard = createGuardServer({
  storage: sqliteStorage({ path: "./data/guard.db" }),
  orgSecret: process.env.GUARD_ORG_SECRET!,
  vaultKey: process.env.GUARD_VAULT_KEY!,
  adminToken: process.env.GUARD_ADMIN_TOKEN!,
  evaluator: llmEvaluator({ ... }),   // optional, Phase 5 stretch
});
// apps/portal/app/api/guard/[...route]/route.ts → guard.nextHandler()
```

### Endpoints (all JSON, versioned envelope from `@webmcp-guard/shared`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /gate` | app session | Policy resolution + posture verdict + inbound detokenize/validate. Returns verdict, transformed args, confirmation id if needed. |
| `POST /transform` | app session | Classify + tokenize/redact/contextualize a tool result; writes the audit log entry. |
| `GET/PUT /policies`, `POST /policies`, `DELETE /policies/:id` | admin token | Policy CRUD for the console. |
| `GET /logs` (+filters, pagination), `GET /logs/:id` | admin token | Audit log for the console; detail includes matched rules and before/after payloads. |
| `GET /stats` | admin token | Dashboard counts (calls, denies, redactions, by tool/agent/day). |
| `POST /tokens/reveal` | admin token | Console-only: reveal a token's value (logged as an admin action). |

CORS: allow the console origin (env-configured) on admin routes.

### Policy model (zod schema in `@webmcp-guard/shared`)

A policy is an ordered list of rules; first match per aspect wins, with a
default-allow-and-log baseline (deny-by-default is a config flag — keep the
demo permissive except where the story needs teeth).

```ts
Rule = {
  id, name, enabled, priority,
  match: {
    apps?: string[],
    tools?: string[] | { tags: string[] },    // e.g. { tags: ["destructive"] }
    agents?: AgentMatcher[],                  // browser brand/version ranges, agent ids, "unknown"
    roles?: string[],                         // session roles (Phase 6)
    dataClasses?: DataClass[],                // matches when payload contains these
  },
  action:
    | { type: "allow" }
    | { type: "deny", message: string }
    | { type: "require-confirmation", message: string }
    | { type: "require-justification", minChars?: number, llmEvaluate?: boolean }
    | { type: "transform", perClass: Record<DataClass,
        "tokenize" | "mask" | "contextualize" | "passthrough"> },
}
```

`DataClass` enum for v1: `ssn`, `mrn`, `name`, `dob`, `phone`, `email`,
`address`, `insurance_id`, `credit_card`, `free_text_phi`.

### Classification engine

- **Field-name pass (primary, reliable):** walk JSON payloads; map key patterns
  (`ssn`, `social`, `dob|birth`, `first_name|last_name|name`, `phone|mobile`,
  `email`, `address|street|zip`, `mrn|record_number`, `insurance`) to classes.
  Configurable per app via policy settings.
- **Regex pass (secondary):** scan string values for SSN
  (`\d{3}-\d{2}-\d{4}` + non-delimited with context), phone, email, MRN
  format, credit card (with Luhn check), ISO/US dates in DOB-ish contexts.
  Applied to free-text fields (visit notes) → `free_text_phi` class with
  in-place span replacement.
- Deterministic tokenization + vault + detokenization as specified in
  `03-architecture.md`. Detokenization must only substitute tokens that exist
  in the vault and only for tools/policies permitted to receive real values;
  unknown tokens pass through untouched.
- Names: rely on field-name classification plus tokenizing known patient names
  appearing in free text (the portal knows its patient list — a dictionary
  scan against seeded names is legitimate and effective). Document NER as
  future work.

### Justification evaluator (Phase 5, stretch)

Pluggable interface: `evaluate({tool, args, justification, context}) →
{ verdict: "pass" | "fail", reason }`. Default implementation: heuristic
(length + must reference the patient/task). Optional LLM implementation behind
`LLM_API_KEY` — provider-agnostic (OpenAI-compatible chat endpoint is fine).
Never let evaluator downtime block the demo: on error, fall back to heuristic
and log the fallback.

## Packages: storage adapters

`GuardStorage` interface: policies CRUD, appendLog, queryLogs, stats,
vault get/put. Implement `storage-sqlite` (better-sqlite3, WAL mode,
migrations as plain SQL files, idempotent init) and `storage-memory` (used in
unit tests and as a documented example of "bring your own database").

## Definition of done for the SDK

- A developer can follow `packages/sdk/README.md` from a blank Next.js app to a
  policy-wrapped tool in under 15 minutes (this README doubles as submission
  evidence that the SDK is generic and agent-friendly — write it so Claude
  Code could execute it, and say exactly that in it).
- Unit tests for: classifier (each class, plus Luhn negative cases),
  tokenization determinism, detokenization round-trip, policy matching order,
  and the gate verdict matrix. Vitest, run in CI-less `pnpm test`.
