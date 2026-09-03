# `@webmcp-guard/sdk` — 15-minute integration guide

This guide takes a blank Next.js app to a policy-wrapped, audited WebMCP tool. It is written to be followed **literally, step by step, by a coding agent** — every path is explicit, every snippet is complete, and every API named here is a real export you can grep for in `packages/sdk/src` and `packages/server/src`. If you are an agent reading this: you can execute this document top to bottom without guessing.

Everything below is accurate to the code as committed. Where a capability is **not** implemented, this guide says so rather than describing the plan.

- **What the guard does to a call:** gate → (human confirmation) → your `execute` runs in the page → transform → the agent gets the transformed result.
- **What the guard never does:** hold the token vault in the browser, return an untransformed result, or make a policy decision client-side.

---

## 0. Install

WebMCP Guard is **not published to npm yet**. The packages are `private: true` workspace packages, consumed one of two ways:

**A. In this monorepo (or your own pnpm workspace).** Copy `packages/shared`, `packages/sdk`, `packages/server` and one storage adapter into your `packages/` directory, then depend on them by workspace protocol:

```
// apps/your-app/package.json
{
  "dependencies": {
    "@webmcp-guard/sdk": "workspace:*",
    "@webmcp-guard/server": "workspace:*",
    "@webmcp-guard/storage-sqlite": "workspace:*"
  }
}
```

**B. From git.** Point your package manager at the repository and the subdirectory, or vendor the four packages. They ship TypeScript source (`main` and `types` both point at `src/index.ts`), so your bundler compiles them with the rest of your app — there is no build step and no `dist/`.

Requirements: **Node ≥ 20**, TypeScript, and a bundler that can consume TS from a dependency (Next.js does this for workspace packages out of the box). The SDK has exactly one runtime dependency, `@webmcp-guard/shared`, and **no React dependency** — see [§7](#7-react).

---

## 1. Mount the server

The guard server is the enforcement point. It lives in **your** app, next to your data, and it owns nothing you do not give it.

Create `app/api/guard/[...route]/route.ts`:

```ts
import { createGuardServer } from "@webmcp-guard/server";
import { sqliteStorage } from "@webmcp-guard/storage-sqlite";

const guard = createGuardServer({
  storage: sqliteStorage({ path: "./data/guard.db" }),
  orgSecret: process.env.GUARD_ORG_SECRET!,
  vaultKey: process.env.GUARD_VAULT_KEY!,
  adminToken: process.env.GUARD_ADMIN_TOKEN!,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PUT, DELETE, OPTIONS } = guard.nextHandler();
```

That is the whole server-side integration. `nextHandler()` returns the five App Router verbs; the catch-all segment gives the guard its own route table underneath your mount point:

| Route                                                                              | Auth               | Purpose                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /gate`                                                                       | your app's session | Resolve policy, check posture, validate confirmations and justifications, detokenize arguments.                                   |
| `POST /transform`                                                                  | your app's session | Classify and transform a tool result; close the audit entry.                                                                      |
| `GET /policies/effective`                                                          | your app's session | The one non-admin policy read: two booleans and a number, so the SDK can shape an input schema.                                   |
| `GET/POST/PUT /policies`, `GET/PUT/DELETE /policies/:id`, `POST /policies/reorder` | `adminToken`       | Policy CRUD for the console.                                                                                                      |
| `GET /logs`, `GET /logs/:id`                                                       | `adminToken`       | Audit log.                                                                                                                        |
| `GET /stats`                                                                       | `adminToken`       | Dashboard counts.                                                                                                                 |
| `POST /tokens/reveal`                                                              | `adminToken`       | Reveal a token's value or a log entry's payloads. **The reveal is itself written to the audit log** before the value is returned. |

> **`/gate` and `/transform` carry no guard-layer authentication, by design.** They are mounted inside your app and reachable by exactly whoever can already reach the page. Your app's own session is the boundary — the same one protecting your data APIs. The guard governs the _agent channel_; it is not a boundary against the person at the keyboard, who already has the data in the DOM. Do not describe these routes as authenticated.

`createGuardServer` **throws at construction** if `orgSecret`, `vaultKey` or `adminToken` is missing or blank, so a misconfigured deployment fails at boot rather than at the first agent call.

### Framework other than Next.js

`nextHandler()` is a thin adapter. The real entry point is framework-agnostic:

```ts
const response = await guard.handle(request, ["gate"]); // standard Request → Response
```

`segments` is the path below your mount point. Any framework that speaks `Request`/`Response` (Hono, Remix, Express with a shim, Cloudflare Workers if you supply a compatible storage adapter) can host it.

### Storage: SQLite, memory, or your own

```ts
// Durable. Creates parent directories; ":memory:" is supported for tests.
sqliteStorage({ path: "./data/guard.db" });

// Or adopt a connection you already have, so the guard's tables
// (guard_rules, guard_logs, guard_vault, …) live in your app's own database
// file. The adapter never closes a connection it did not open.
sqliteStorage({ database: myBetterSqlite3Connection });
```

```ts
import { memoryStorage } from "@webmcp-guard/storage-memory";

// Not durable, not process-safe. The store the unit tests run against,
// and a complete, readable worked example of the adapter contract.
const guard = createGuardServer({
  storage: memoryStorage(),
  orgSecret,
  vaultKey,
  adminToken,
});
```

**Bring your own database** by implementing the `GuardStorage` interface from `@webmcp-guard/shared` — Postgres, MySQL, DynamoDB, whatever you already run. The contract is one interface with four groups of methods:

| Group                 | Methods                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle             | `init()` (idempotent — it is called on every boot and _is_ the migration), `close()`                                                  |
| Policy                | `getPolicy`, `listRules`, `getRule`, `createRule`, `updateRule`, `deleteRule`, `reorderRules`, `getDefaultAction`, `setDefaultAction` |
| Audit                 | `appendLog`, `completeLog`, `getLog`, `queryLogs`, `stats`                                                                            |
| Vault & confirmations | `putVaultEntry`, `getVaultEntry`, `putConfirmation`, `consumeConfirmation`                                                            |

Two behaviors an adapter **must** get right, because security depends on them:

- `completeLog(callId, …)` is **single-shot**: it returns `null` if the entry is missing _or already complete_, so a replayed `/transform` cannot overwrite a closed audit record.
- `consumeConfirmation(id)` **atomically removes and returns** the entry, and returns `null` on the second call even if two requests race. It deliberately does **not** check expiry — an expired id is still returned and still destroyed, so the caller can burn a replay attempt _before_ judging it.

Both adapters in this repo are validated by one shared conformance suite; run it against yours.

---

## 2. Wrap your tools

Client side. Create the guard once per page — it owns the event stream, so a second instance splits your history in two:

```ts
// lib/guard.ts
"use client";
import { createGuard } from "@webmcp-guard/sdk";

export const guard = createGuard({
  endpoint: "/api/guard", // where you mounted the server in step 1
  app: "my-app", // app identifier used for policy scoping
});
```

Now change your registration call. **This is the entire integration diff:**

```diff
- await document.modelContext.registerTool({
+ await guard.registerTool({
    name: "search_customers",
    description: "Search the customer directory and return one summary per match.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
+   tags: ["read", "pii"],
    execute: async (input) => search(input.text),
  }, { signal });
```

One line changes and one is added. `guard.registerTool` takes the same shape `document.modelContext.registerTool` takes, applies the pipeline, and hands the wrapped tool to the browser — through the literal `document.modelContext.registerTool(` call in [`src/webmcp.ts`](src/webmcp.ts), with a `navigator.modelContext` fallback for the older explainer surface.

What changed for your tool, concretely:

- **`tags`** is the guard's one addition to the WebMCP tool shape: free-form strings your policy rules match on (`{ tools: { tags: ["destructive"] } }`). Tags are **stripped** before the definition reaches the browser and travel on the gate request instead.
- **`annotations`** (`readOnlyHint`, `untrustedContentHint`) are carried through to the browser unchanged. You set them per tool; the guard does not invent them.
- **`inputSchema`** is deep-copied, never mutated, and gets a required `justification` property injected when policy demands one. Your object is never touched.
- **`execute`** is called with the **detokenized** arguments the gate returned, and only after a validated `allow` verdict.
- **The `context` argument is optional.** Declare it `execute(input, context?)` and read `context?.signal`. Chromium 151 invokes `execute(input)` with **no** second argument despite the typings declaring one — every implementation must tolerate its absence.
- **Registration never throws.** It resolves with `{ tool, surface, registered }`. `registered: false` means WebMCP is absent, the signal was already aborted, or the browser rejected the definition. A browser without WebMCP logs one warning per page and your page keeps working for humans.

Unregistration is the `AbortSignal` you passed, exactly as with raw WebMCP:

```ts
const controller = new AbortController();
await guard.registerTool(definition, { signal: controller.signal });
controller.abort(); // tool is unregistered
```

---

## 3. Seed a policy and pair the console

The server seeds a default policy into an **empty** store on first boot and never touches a store that already has rules — so an administrator who deletes a default rule keeps it deleted. Set `seed: false` if your app manages policy itself.

The shipped default (`DEFAULT_POLICY_RULES` in `@webmcp-guard/server`) is written for the demo portal; treat it as a worked example and replace it. A rule looks like this:

```ts
{
  id: "pii-transform-default",
  name: "Tokenize PII on pii-tagged tools",
  enabled: true,
  priority: 10,
  match: { tools: { tags: ["pii"] } },
  action: {
    type: "transform",
    perClass: {
      ssn: "tokenize",
      name: "tokenize",
      dob: "contextualize",   // → "age 40-49"
      address: "contextualize", // → city/state
      email: "mask",
      phone: "passthrough",
    },
  },
}
```

Rules are ordered by `priority` ascending. **Two aspects resolve independently, first match each:** the _gate verdict_ (`allow` / `deny` / `require-confirmation` / `require-justification`) and the _transform matrix_. There is no merging of matrices anywhere in the engine — the first matching `transform` rule supplies the whole matrix, so a role- or tool-scoped override must carry a **full** copy of the matrix it is varying, not a delta.

Match on `apps`, `tools` (a name list or `{ tags: [...] }`), `agents` (browser brand/version ranges, agent ids, `"unknown"`), `roles`, and `dataClasses`. Data classes for v1: `ssn`, `mrn`, `name`, `dob`, `phone`, `email`, `address`, `insurance_id`, `credit_card`, `free_text_phi`.

**Pair the console** (`apps/console` in this repo — a stateless Next.js client of the API you mounted):

1. Set `NEXT_PUBLIC_GUARD_API_URL` on the console to your mount, e.g. `https://your-app.example.com/api/guard`.
2. Set `consoleOrigin` on `createGuardServer` (the demo reads `GUARD_CONSOLE_ORIGIN`) to the console's **exact** origin — no trailing slash, no wildcard mode. The guard echoes exactly that origin in `Access-Control-Allow-Origin` on the admin routes and never `*`; credentials are never allowed, because the console authenticates with a bearer token rather than cookies.
3. Log in with `adminToken`.

If the console and your app share an origin, omit `consoleOrigin` entirely — same-origin needs no CORS.

---

## 4. Configuration reference

### `createGuardServer(config: GuardServerConfig)`

| Field                 | Type                                                              | Required | What it does                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`             | `GuardStorage`                                                    | ✅       | Where policy, logs, the vault and pending confirmations live.                                                                                                                                                                                                                                                                                                                                |
| `orgSecret`           | `string`                                                          | ✅       | HMAC key behind deterministic tokens. Changing it invalidates every existing token.                                                                                                                                                                                                                                                                                                          |
| `vaultKey`            | `string`                                                          | ✅       | AES-256-GCM key for the vault. Entries written under a different key cannot be decrypted, and the reveal route says so explicitly.                                                                                                                                                                                                                                                           |
| `adminToken`          | `string`                                                          | ✅       | Bearer token for the console-facing admin routes.                                                                                                                                                                                                                                                                                                                                            |
| `consoleOrigin`       | `string`                                                          | —        | The one exact origin allowed to call the admin routes cross-origin. Omit for same-origin. There is no wildcard mode.                                                                                                                                                                                                                                                                         |
| `seed`                | `boolean`                                                         | —        | Seed `DEFAULT_POLICY_RULES` into an empty store. Defaults to `true`.                                                                                                                                                                                                                                                                                                                         |
| `nameDictionary`      | `() => string[] \| Promise<string[]>`                             | —        | Known person names for the free-text scan. Regexes cannot recognize a name; your application already knows exactly who its people are. Called at most once per `nameDictionaryTtlMs`; throwing is safe (logged, other detectors continue).                                                                                                                                                   |
| `nameDictionaryTtlMs` | `number`                                                          | —        | Cache lifetime for the compiled matcher. Defaults to `NAME_DICTIONARY_TTL_MS` (30 000 ms).                                                                                                                                                                                                                                                                                                   |
| `mrnPattern`          | `RegExp`                                                          | —        | Replaces the default `LM-100042`-shaped medical-record-number detector with your own identifier format.                                                                                                                                                                                                                                                                                      |
| `evaluator`           | `JustificationEvaluator`                                          | —        | Judges the `justification` an agent supplies. Defaults to `heuristicJustificationEvaluator`. A throw _or_ a malformed answer is treated as evaluator downtime: the heuristic decides instead and the fallback is recorded on the audit entry. An evaluator outage must never block every export in the building. **An LLM implementation is not shipped** — this is the seam one plugs into. |
| `resolveSession`      | `(request: Request) => SessionContext \| undefined \| Promise<…>` | —        | Resolves the **verified** identity behind a gate call from whatever you already use to authenticate people. See below.                                                                                                                                                                                                                                                                       |

**About `resolveSession`, because it is the one field with a security-relevant contract.** `GateRequest.sessionContext` is filled in by the page through the SDK's `getSessionContext`. That is a _claim_ — worth exactly what the page is worth, and the page is not a boundary against the person at the keyboard. A role-scoped policy that trusted it could be re-roled by anyone who can open DevTools. When a resolver is configured, its answer is what the policy engine matches `match.roles` against **and** what the audit entry records:

| Resolver                              | Session used          | Why                                                     |
| ------------------------------------- | --------------------- | ------------------------------------------------------- |
| returns a context                     | that context          | verified beats claimed, always                          |
| returns `undefined`                   | the client's claim    | an answer: "this host has no session of its own here"   |
| throws, or answers with a non-session | **no session at all** | a failure is not permission to believe the page instead |

A disagreement between the claim and the resolved identity is appended to the audit entry's message rather than silently dropped.

### `createGuard(options: CreateGuardOptions)`

| Field                 | Type                                | Required | What it does                                                                                                                                                               |
| --------------------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`            | `string`                            | ✅       | Where you mounted the server, e.g. `"/api/guard"`.                                                                                                                         |
| `app`                 | `string`                            | ✅       | App identifier for policy scoping (`match.apps`).                                                                                                                          |
| `getSessionContext`   | `() => SessionContext \| undefined` | —        | Identity context, read fresh on every tool call. Throwing is tolerated — the call proceeds without it. Remember it is a claim; pair it with `resolveSession`.              |
| `onBlocked`           | `(info: BlockedInfo) => void`       | —        | Fired on every non-allow verdict, with `{ tool, callId, verdict, message, ruleIds }`. Wire it to a toast.                                                                  |
| `confirmationHandler` | `ConfirmationHandler`               | —        | Replaces the built-in approval modal. Defaults to `defaultConfirmationHandler`.                                                                                            |
| `fetchImpl`           | `typeof fetch`                      | —        | Injectable transport, for tests or a wrapped client.                                                                                                                       |
| `policyRefreshMs`     | `number`                            | —        | How often registered tools re-check effective policy. Defaults to `POLICY_REFRESH_INTERVAL_MS` (30 000 ms). `0` disables the timer; `guard.refreshPolicies()` still works. |

`createGuard` throws only for a misconfigured call (missing `endpoint` or `app`) — a programmer error worth surfacing loudly at startup. It never throws because of the browser.

### The `Guard` object

| Member                               | Type                                         | Notes                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`                          | `boolean`                                    | Re-detected on every read.                                                                                                                                                             |
| `surface`                            | `"document" \| "navigator" \| "unavailable"` | Which WebMCP entry point was found.                                                                                                                                                    |
| `registerTool(definition, options?)` | `Promise<RegistrationResult>`                | Never throws.                                                                                                                                                                          |
| `subscribe(listener)`                | `() => void`                                 | Returns an unsubscribe function.                                                                                                                                                       |
| `recentEvents()`                     | `GuardEvent[]`                               | The last 50 (`GUARD_EVENT_BUFFER_SIZE`) events, oldest first, so a late-mounted UI has history.                                                                                        |
| `refreshPolicies()`                  | `Promise<number>`                            | Re-reads effective policy for every live tool and re-registers those whose input schema changed. Resolves with how many were rebuilt. Never throws; concurrent callers share one pass. |

---

## 5. Fail-closed semantics, and what the agent reads

The pipeline holds four invariants. Read them as the security contract:

0. A `require-confirmation` verdict becomes a call **only** via a second gate round trip carrying the one-time id the guard issued, and only after a human decision. Declining, cancelling, a handler that throws, and a missing id all stop the call.
1. Your `execute` runs **only** after a validated `allow` verdict.
2. **A raw, untransformed result never reaches the agent.** If `/transform` cannot be reached or answers with something outside the wire contract, the result is dropped and the agent is told it was withheld.
3. Everything returned to the agent is actionable prose. Raw failure detail (HTTP status, thrown message) goes to the page-local event stream instead, where the human — already inside the trust boundary — can see it.

Every string a model reads back is exported from `@webmcp-guard/sdk` so you can inspect, test against, or translate it:

| Export                             | When the agent sees it                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verificationFailedMessage(stage)` | The gate or transform round trip failed. The result was withheld.                                                                                              |
| `declinedMessage(policyMessage?)`  | A person declined the approval. Says who decided, repeats the policy's reason, and tells the model to report back rather than retry.                           |
| `APPROVAL_NOT_ACCEPTED_MESSAGE`    | Approved in the page, but the follow-up gate refused the approval (expired, arguments changed, policy moved).                                                  |
| `CONFIRMATION_UNAVAILABLE_MESSAGE` | Approval was required but no prompt could be opened.                                                                                                           |
| `CANCELLED_MESSAGE`                | The call was aborted before it finished.                                                                                                                       |
| `executeFailedMessage(tool)`       | Your `execute` threw. **The reason is deliberately omitted** — thrown messages routinely carry SQL, file paths, or the very data the guard exists to withhold. |
| `invalidArgumentsMessage(tool)`    | The agent sent something that is not a JSON object. Nothing ran.                                                                                               |
| `EMPTY_RESULT_MESSAGE`             | The tool succeeded and returned nothing.                                                                                                                       |
| `BLOCKED_FALLBACK_MESSAGE`         | A non-allow verdict arrived without a policy message.                                                                                                          |
| `WEBMCP_UNAVAILABLE_WARNING`       | Console warning, once per page, when there is no WebMCP to register against.                                                                                   |

Server-side denial and prompt text is composed in `@webmcp-guard/server` (`denyMessage`, `confirmationMessage`, `justificationMessage`, `confirmationRejectedMessage`, `defaultDenyMessage`, `verdictMessage`) and always names the deciding rule, so a model — and a reader of your audit log — can tell _which_ policy spoke:

> `Blocked by policy Export requires justification (export-requires-justification): …`

---

## 6. Events: build your own activity UI

Every stage emits a page-local event. Subscribe and render:

```ts
const unsubscribe = guard.subscribe((event) => {
  // event: { type, tool, callId?, verdict?, decision?, at, detail? }
  console.log(event.type, event.tool, event.detail);
});

// A late-mounting component can backfill:
const history = guard.recentEvents();
```

`type` is one of `"gate" | "confirmation" | "blocked" | "executed" | "transformed" | "error"`. Unlike the strings returned to the agent, `detail` may carry raw failure reasons — the human at the keyboard is inside the trust boundary.

A listener that throws is caught and logged; it cannot break the pipeline. The demo portal's Agent Activity drawer (`apps/portal/components/agent-activity-drawer.tsx`) is ~200 lines built entirely on this API, and auto-opens on a `"blocked"` event so the person can see why the agent was just told no.

---

## 7. React

The SDK has **no React dependency and must not grow one** — it has to work in plain JS, Svelte or Vue pages, and a duplicated React copy in a host's tree is a classic "invalid hook call". So the hook is a factory you bind to _your_ React instance once:

```tsx
import * as React from "react";
import { createUseGuardTool } from "@webmcp-guard/sdk/react";

export const useGuardTool = createUseGuardTool(React);

function CustomerTools() {
  useGuardTool(guard, searchCustomersTool, [guard]);
  return null;
}
```

It registers on mount (and when `deps` change), and aborts the registration signal on unmount. `deps` defaults to `[]` — register once per mount — rather than `undefined`, which would re-register on every render. StrictMode's double mount is safe: an already-aborted signal registers nothing.

---

## 8. Checklist

- [ ] `pnpm install`; the four packages resolve.
- [ ] `GUARD_ORG_SECRET`, `GUARD_VAULT_KEY`, `GUARD_ADMIN_TOKEN` set to real values in every non-local environment.
- [ ] Guard server mounted at `app/api/guard/[...route]/route.ts` with `runtime = "nodejs"` if you use SQLite.
- [ ] `createGuard` called once per page, `endpoint` matching the mount.
- [ ] Every `registerTool` call replaced with `guard.registerTool`, with `tags` added.
- [ ] Every `execute` reads `context?.signal`, not `{ signal }`.
- [ ] Policy seeded or written; the shipped defaults replaced with yours.
- [ ] `nameDictionary` wired if your data contains person names in free text.
- [ ] `resolveSession` wired if any rule matches on `roles`. Without it, roles are whatever the page claims.
- [ ] `consoleOrigin` set if the console is on a different origin.
- [ ] Run a tool from a WebMCP browser and confirm one audit entry per call.

---

## Known limits

Stated rather than hidden, because you are going to find them anyway:

- **Classification is patterns plus a dictionary, not NER.** Field names first, then regex over string values (SSN, phone, e-mail, MRN, credit card with a Luhn check, dates in DOB-ish contexts), then a host-supplied name dictionary for free text. Bare first names in prose are not matched. Machine-learned entity recognition is future work.
- **The transform aspect takes exactly one rule's matrix.** No merging. Scoped overrides must copy the full matrix.
- **A rule cannot require confirmation _and_ justification at once** — `action` is a union. Combining them is future work.
- **Confirmation ids are not bound to a session** — only to the app, the tool and a hash of the arguments, plus a 120-second TTL (`CONFIRMATION_TTL_MS`), plus single use.
- **A registration-time policy read failure registers the tool without injection.** Availability wins at the schema layer; the gate still enforces on every call.
- **No LLM justification evaluator is shipped.** The interface and config plumbing are (`JustificationEvaluator`, `GuardServerConfig.evaluator`); the implementation is not.

---

MIT licensed. Threat model and architecture: the [root README](../../README.md).
