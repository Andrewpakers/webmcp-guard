# 03 — Architecture

## Monorepo layout (pnpm workspaces)

```
webmcp-guard/
├── CLAUDE.md
├── LICENSE                      # MIT (challenge requirement)
├── README.md                    # quickstart, architecture diagram, registerTool excerpt
├── docs/                        # this pack
├── packages/
│   ├── sdk/                     # @webmcp-guard/sdk — client-side wrapper (browser)
│   ├── server/                  # @webmcp-guard/server — Node runtime: policy engine,
│   │                            #   classifiers, token vault, log writer, route handlers
│   ├── storage-sqlite/          # @webmcp-guard/storage-sqlite — better-sqlite3 adapter
│   ├── storage-memory/          # @webmcp-guard/storage-memory — in-memory adapter (tests/demos)
│   └── shared/                  # @webmcp-guard/shared — types, policy schema (zod), constants
└── apps/
    ├── portal/                  # Lakeside Medical demo app (Next.js, uses sdk + server)
    └── console/                 # WebMCP Guard management console (Next.js, stateless client
                                 #   of the portal's WebMCP Guard API)
```

Key boundary: **the console has no database of its own.** It is a pure client
of the WebMCP Guard HTTP API that `@webmcp-guard/server` mounts inside the host app
(the portal). This keeps the SDK story clean ("your app owns the data store,
the console plugs into it") and eliminates shared-database deployment problems.

## Data flow — the tool-call pipeline

```
Agent (ChatGPT in-app browser / Chrome)
  │  calls WebMCP tool
  ▼
document.modelContext ──▶ WebMCP Guard-wrapped execute()   [@webmcp-guard/sdk, browser]
                             │ 1. POST /api/guard/gate  (tool, args, posture snapshot)
                             ▼
                          @webmcp-guard/server (Next.js route handlers in the host app)
                             2. resolve matching policy rules
                             3. posture verdict (browser/agent signals vs policy)
                             4. inbound transform: detokenize args via token vault,
                                validate justification if required
                             5. verdict: allow | deny | require-confirmation | require-justification
                             │
             ┌───────────────┤ verdict returned to sdk
             ▼               │
   deny → structured error   │ allow
   to agent + log            ▼
                          6. sdk runs the site's original execute(args*)  (in page,
                             so the human sees the action happen in the UI)
                             │ result
                             ▼
                          7. POST /api/guard/transform (result)
                             → classify + tokenize/redact/contextualize per policy
                             → write audit log entry (original + transformed, rule ids)
                             │
                             ▼
                          8. transformed result returned to the agent
```

Notes on the split:

- **Server-side is the enforcement point** for anything secret: the token
  vault (token ⇄ value mapping), policy storage, log storage, and the LLM
  justification evaluator. The client SDK never holds the detokenization map.
- **Client-side is the integration point**: it owns registration/unregistration
  with `document.modelContext`, schema rewriting, the human-confirmation modal,
  and graceful degradation when WebMCP is absent.
- Steps 1/7 can be a single round trip for simple tools; implement as two
  phases only where needed (e.g., confirmation flows). Keep the wire format
  one clean, versioned JSON contract in `@webmcp-guard/shared`.
- For `require-confirmation`, the SDK renders an in-page modal the human must
  approve; the server issues a one-time confirmation id so the approval can't
  be replayed.

## Tokenization design

- Deterministic: `token = "tok_" + class + "_" + hmac_sha256(value, org_secret)[0:8]`
  (lowercase hex). Same value → same token everywhere, so agents can match
  identities across tools and turns.
- Format is chosen to survive LLM copying: lowercase, ASCII, no brackets or
  punctuation that models mangle.
- Vault table stores `token → encrypted(value)` (AES-256-GCM with a key from
  env) plus class and first-seen metadata. Detokenization happens only
  server-side during inbound transform, and only when policy permits that tool
  to receive the real value.
- Contextualization is an alternative action per data class: e.g. DOB →
  `"age 40-49"`, address → city/state only, name → `"Patient tok_name_xxxx"`.
- Classification strategy (see `04-sdk-requirements.md`): structured-field
  classification by JSON key patterns first (reliable), regex scanning of
  string values second (SSN, phone, email, MRN, credit card w/ Luhn, DOB).

## Threat model — write this down and keep it honest

**In scope (what WebMCP Guard actually protects against):**

- Sensitive data leaking into the agent's context / a third-party LLM via tool
  results.
- Agents invoking destructive or out-of-policy tools (delete, export) without
  authorization, justification, or human confirmation.
- No audit trail of agent activity.
- Agents operating from unacceptable environments (ancient browser, unknown
  agent, insecure context).

**Out of scope (never claim otherwise):**

- A malicious human user: the page's own JS has the raw data; anyone with
  DevTools can read it. WebMCP Guard governs the *agent channel*, not the DOM.
- A malicious host page: WebMCP Guard is the site's own dependency, not a
  sandbox around the site.
- Agent identification is best-effort (UA Client Hints etc. are spoofable);
  treat agent identity as an advisory signal, and say so in the console UI.

**Can the agent go *around* the tools?** Framing: WebMCP Guard is a compliance
and governance layer for the agent channel — the human already has full access
to the data. The circumvention question is therefore: can a browser agent get
raw data or take actions without going through the guarded tools?

- *Direct API calls / tampered client code:* No. Enforcement lives server-side.
  The gate, the token vault, detokenization, and logging are in
  `@webmcp-guard/server`; the app's data APIs can (and in the demo, do for the
  sensitive routes) require a valid gate decision. An agent that ignores the
  client SDK gets tokenized data or a denial from the server, same as ever.
- *DOM scraping / actuation:* Partially. An agent that actuates the human UI
  (clicks, reads the page, screenshots) sees whatever the human sees. Two
  mitigations, both worth shipping: (1) **masked-at-rest UI** — render
  sensitive fields masked/tokenized in the DOM with an explicit click-to-reveal
  per field, so the page an agent scrapes contains tokens, and reveals are
  logged like any other access (see the stretch item in
  `05-demo-app-requirements.md`); (2) set `annotations.untrustedContentHint`
  and write tool descriptions that make the tool path the efficient path, so
  well-behaved agents have no reason to scrape.
- *The residual gap:* a fully actuating agent driving a revealed UI is
  indistinguishable from the human. Closing that requires cooperation from the
  browser/agent runtime (e.g., an enterprise browser policy that restricts
  agents to the tool channel). Name this plainly in the README as the
  deployment model webmcp-guard slots into — it's the honest answer and a
  strong "future work" story.

This candor is a feature in front of these judges, not a weakness. Put a
condensed version of this section in the repo README and the submission text.

## Persistence & deployment decision

Constraint from the project owner: no external SaaS (no Supabase etc.); the
SDK consumes a company-provided database via a storage adapter; the demo uses
SQLite.

The catch: **SQLite does not survive on Vercel** — serverless functions have an
ephemeral, mostly read-only filesystem and no shared disk, so logs written in
one invocation vanish or never appear in another. Decision:

- **Portal (stateful, owns SQLite): deploy to Render as a Node web service**
  (`next start` on a long-running instance; Render is a challenge sponsor and
  an explicitly blessed host). Free-tier disks are ephemeral across
  deploys/restarts, so run an idempotent **seed-on-boot** script: if the DB is
  missing, create schema + demo patients + default policies. Losing logs on a
  redeploy is acceptable for a demo; note the cold-start delay of free
  instances and consider the cheapest paid instance for judging week.
- **Console (stateless): deploy to Vercel**, configured with
  `NEXT_PUBLIC_GUARD_API_URL` pointing at the portal. Enable CORS on the
  portal's `/api/guard/*` routes for the console origin; protect console
  API access with a simple admin bearer token (env var), entered once on a
  console login screen.
- Fallback if Render misbehaves: run both apps on a single Render service
  (console pages mounted in the portal app under `/console`) — keep this
  escape hatch in mind, don't build for it up front.
- Local dev: everything runs with `pnpm dev`, SQLite file in `apps/portal/data/`.

## Other cross-cutting decisions

- TypeScript everywhere; `webmcp-types` npm package for WebMCP typings.
- Zod schemas in `@webmcp-guard/shared` for policy documents, wire contracts, and
  log entries — single source of truth for both apps and the SDK.
- Feature-detect `document.modelContext` then `navigator.modelContext`; if
  absent, portal shows a small banner ("WebMCP not detected — enable
  chrome://flags/#enable-webmcp-testing or open in ChatGPT's browser") and all
  human UI keeps working.
- WebMCP requires origin isolation and the `tools` permissions policy default
  (`self`) — no cross-origin iframes in this project, so defaults are fine; do
  not set `Origin-Agent-Cluster: ?0`.
- Secrets in env: `GUARD_ORG_SECRET` (HMAC), `GUARD_VAULT_KEY` (AES),
  `GUARD_ADMIN_TOKEN` (console), optional `LLM_API_KEY` (justification
  evaluator, stretch). Ship `.env.example`.
