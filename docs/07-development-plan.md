# 07 — Development Plan (living document)

**Claude Code: this file is yours to maintain.** Check items off as they're
completed, append to the Work Log after every session, and note any deviation
from the docs inline next to the relevant item. Commit at every phase boundary
and after each major step (conventional commits).

**Clock:** deadline Sep 3, 2026, 1:00 PM PDT (~5 days from pack creation).
Suggested pacing: Phases 0–2 day 1, Phase 3 day 2, Phase 4 day 3, Phase 5 day
4 (morning), Phases 6–7 day 4–5, submit day 5 morning — never the final hour.

**Rule of thumb:** from Phase 4 on, the project must be submittable at all
times. If any item threatens that, stub it and move on.

**Process:** all work follows `docs/10-agent-operations.md` — orchestrator
delegates to Opus sub-agents (high effort; max effort for hard tasks), every
task ships with its tests, and each phase below ends with a review gate before
its commit (Fable for security-critical phases 2/3/5, Opus reviewer otherwise,
suite green).

---

## Phase 0 — Scaffold (target: ~1 hour)

- [x] Init repo, MIT `LICENSE` at root, `.gitignore`, root `README.md` stub
- [x] pnpm workspace with empty packages per `03-architecture.md` layout
- [x] TypeScript base config, shared tsconfig, ESLint + Prettier (light-touch)
- [x] `apps/portal` and `apps/console`: fresh Next.js (App Router, TS,
      Tailwind), boot on ports 3000/3001 _(hand-written rather than
      create-next-app to avoid workspace conflicts — allowed by dispatch)_
- [x] `@webmcp-guard/shared`: zod schemas for Rule, DataClass, wire envelope, log
      entry (from `04-sdk-requirements.md`)
- [x] `.env.example` with all secrets named in `03-architecture.md`
- [x] Vitest wired at root (`pnpm test`/`typecheck`/`lint` scripts) with one
      passing placeholder test per package
- [x] `.claude/agents/`: implementer, implementer-hard, reviewer, solver per
      `10-agent-operations.md` _(note: definitions load at session start, so
      this session dispatches via general-purpose agents + model override +
      persona rules inlined in the prompt — same intent)_
- [x] Copy this docs pack into `docs/`; `CLAUDE.md` at root
- [x] **Commit: `chore: scaffold monorepo`**

## Phase 1 — Portal with raw WebMCP (the "before" picture)

- [x] Portal SQLite schema + deterministic faker seed (~60 patients, notes with
      embedded PHI, appointments); idempotent seed-on-boot
- [x] Human UI: patient list w/ search, patient detail, edit, add note, export
      CSV, delete w/ confirm ("Demo environment" banner everywhere)
- [x] Register all 7 tools from `05-demo-app-requirements.md` directly via
      `document.modelContext.registerTool` (no WebMCP Guard yet), with
      feature-detection fallback + header status chip _(the "Agent Activity"
      drawer from docs/05 is deferred to Phase 2, where it has live guard events
      to show)_
- [x] Verify in Chrome (flag enabled) with the Model Context Tool Inspector:
      every tool callable, results correct _(done via headless snap Chromium
      151 + `--enable-features=WebMCP` driven over CDP by
      `scripts/webmcp-e2e.mjs` — no Inspector extension available headless,
      but all 7 tools were listed and executed for real through
      `modelContext.executeTool`; final Inspector/ChatGPT pass still due in
      Phase 7 against the live URL)_
- [x] Capture screenshots/notes of the unprotected behavior (raw SSNs in
      results, silent delete) for the video's "before" segment
      _(docs/captures/phase1-before/)_
- [x] Review gate (Opus reviewer, suite green) — APPROVED
- [x] **Commit: `feat(portal): Lakeside Medical with raw WebMCP tools`**

## Phase 2 — SDK core: wrap, gate, log

- [x] `@webmcp-guard/storage-memory` + `@webmcp-guard/storage-sqlite` implementing
      `GuardStorage` (policies, logs, vault, stats) _(one shared contract suite
      runs against both; sqlite supports `{database}` adoption so guard tables
      live inside the host app's own DB file)_
- [x] `@webmcp-guard/server`: `createGuardServer`, Next.js catch-all adapter,
      `/gate` (policy match + verdict, no transforms yet), `/transform`
      (logging passthrough), `/policies` CRUD, `/logs` query _(+ `/stats`,
      `GET /policies/:id`, `PUT /policies` for defaultAction, reorder route,
      opt-in exact-origin CORS)_
- [x] Policy engine: ordered rule matching per `04-sdk-requirements.md`,
      seeded default policies from `05-demo-app-requirements.md` _(two-aspect
      resolution: gate verdict + transform matrix independently, first match
      each; `agents`/`dataClasses` matchers explicitly inert until Ph5/Ph3;
      justification/confirmation rules seeded DISABLED until Phase 5; TEMP
      enabled deny rule on delete_patient for the Phase 2 demo)_
- [x] `@webmcp-guard/sdk`: `createGuard`, `registerTool` wrapper (visible
      `document.modelContext.registerTool` call), execute pipeline
      gate → execute → transform → return, structured agent-facing errors,
      AbortSignal passthrough _(fail-closed everywhere; literal registerTool
      call lives in packages/sdk/src/webmcp.ts; events API + ring buffer for
      the Agent Activity drawer; React helper is a dependency-free factory)_
- [x] Portal migrated from raw registration to WebMCP Guard; Agent Activity
      drawer showing live events _(guard server mounted inside the portal at
      `/api/guard`, sharing the portal's own SQLite connection; missing
      `GUARD_*` env vars fall back to obviously-insecure dev defaults with a
      one-time server warning so a clean clone boots — **README must say this
      out loud in Phase 7**)_
- [x] Deny path works end to end (temporary deny rule on `delete_patient`);
      agent receives legible policy message; log entry written _(verified by
      curl against `/api/guard/gate`, by `scripts/webmcp-e2e.mjs call
      delete_patient` in headless Chromium — patient still present afterwards —
      and in `GET /api/guard/logs`)_
- [x] Unit tests: policy matching order, verdict matrix
- [x] Review gate (**Fable** — critical phase, suite green) — APPROVED
- [x] **Commit: `feat(sdk): core wrapper, policy gate, audit logging`**

## Phase 3 — Data controls (the headline feature)

- [x] Classifier: field-name pass + regex pass + seeded-name dictionary scan
      for free text (all classes in `04-sdk-requirements.md`) _(dictionary is
      host-supplied via `GuardServerConfig.nameDictionary`; full names +
      honorific+surname only — bare first names by design)_
- [x] Deterministic tokenization + encrypted vault; token format
      `tok_<class>_<hex8>` _(HMAC-SHA256 over class-bound canonicalized value;
      AES-256-GCM vault with the token as AAD; 32-bit truncation trade-off
      documented in tokenize.ts)_
- [x] Outbound transform per policy matrix: tokenize / mask / contextualize
      (DOB→age bracket, address→city/state) / passthrough _(missing
      contextualizer falls back to tokenize, never passthrough)_
- [x] Inbound detokenization in `/gate` (tokens in args → real values, policy
      permitting; unknown tokens untouched) _(only after an allow verdict;
      single pass, vault values never re-scanned)_
- [x] Free-text span replacement in visit notes (in and out) _(spans follow
      their own class's matrix action; free_text_phi reported as a class)_
- [x] End-to-end agent test in Chrome: search → tokens returned → pass token to
      `get_patient` → correct record; add note referencing token → resolves
      _(headless Chromium harness; note stored with real names, agent echo
      tokenized; verified again post-review on a fresh DB)_
- [x] Unit tests: each detector (+ Luhn negatives), token determinism,
      round-trip, transform matrix
- [x] Review gate (**Fable** — critical phase, suite green) — APPROVED
- [x] **Commit: `feat(sdk): classification, tokenization, detokenization`**

## Phase 4 — Console (minimum submittable product line)

- [x] Console shell: token login, layout, nav _(sessionStorage-only token,
      validated against `/stats` before storing)_
- [x] Audit log table + filters + auto-refresh + detail drawer with
      before/after payloads and gated reveal (reveal is logged) _(reveal
      verified to write a `console_reveal` audit entry)_
- [x] Policy list + structured rule editor + per-class transform matrix +
      enable/disable + reorder; JSON escape hatch _(round-trip byte-identical;
      `ToolMatcherSchema` now rejects empty tool lists so the JSON hatch
      cannot widen a rule to match-everything)_
- [x] Dashboard: stat cards, 2 charts, recent activity _(stat card renamed
      "Sensitive data handled" — storage counts classified calls, not
      rewritten ones; the per-entry badge checks real before/after diffs)_
- [x] CORS + admin-token auth on portal admin routes _(exact-origin ACAO
      verified; disallowed origin gets none)_
- [x] Live-edit proof: change a transform in console → next agent call behaves
      differently, no redeploy _(verified twice: rule PUT name→mask, and
      disable→raw)_
- [x] Review gate (Opus reviewer; Fable spot-check on auth/CORS, suite green)
      — REQUEST CHANGES (2 findings: transformed-badge overclaim, `tools: []`
      widening) → both fixed by orchestrator + tests, suite 880 green
- [x] **Commit: `feat(console): logs, policies, dashboard`**
- [x] ☑ Checkpoint: from here the project is submittable. Deploy early (see
      Phase 7 deploy items) rather than waiting.

## Phase 5 — Posture, confirmation, justification

- [x] Posture snapshot in SDK (UA Client Hints + fallback, secure context,
      best-effort agent id) and posture matchers in the policy engine
      _(UA parsing lives in `@webmcp-guard/shared/user-agent` so the SDK and the
      server derive identical brands; `agents` removed from
      `UNEVALUATABLE_MATCHERS`; a rule with an `agents` matcher does **not**
      fire when a call carried no posture — permissive on purpose, documented
      in `agentMatches`)_
- [x] Posture rule pack seeded but **disabled by default** (judge-safety);
      console toggle _(`posture-deny-unknown-agent`, `posture-deny-old-browser`
      at priorities 5/6 — posture decides before anything else)_
- [x] `require-confirmation` flow: in-page modal, one-time confirmation id,
      decline returns policy explanation to agent _(id is consumed **before**
      it is validated, so a replayed or tampered attempt burns it; the modal is
      vanilla DOM with `data-testid` hooks and a replaceable
      `confirmationHandler`)_
- [x] `require-justification`: schema injection of required `justification`
      field on gated tools; heuristic evaluator; justification + verdict in
      logs/console _(new non-admin `GET /policies/effective`; the gate strips
      the field before the tool runs and keeps it in the audit entry)_
- [ ] Stretch (skip if behind): pluggable LLM evaluator behind `LLM_API_KEY`,
      heuristic fallback on error _(**interface + config plumbing shipped**
      (`GuardServerConfig.evaluator`, `JustificationEvaluator`), LLM
      implementation deliberately skipped)_
- [ ] Stretch (skip if behind): masked-at-rest UI fields with logged
      click-to-reveal (anti-circumvention demo, see docs/05 + threat model)
- [x] Review gate (**Fable** — critical phase, suite green) — APPROVED
- [x] **Commit: `feat: posture checks, confirmation, justification`**

## Phase 6 — Roles (optional; cut first if behind)

- [x] Mock login (3 personas, signed session cookie w/ role) _(header
      persona-switcher instead of a `/login` page — one obvious click for the
      video; `POST /api/session` signs `base64url(userId.role.issuedAt)` +
      HMAC-SHA256, httpOnly + SameSite=Lax, no expiry by design; key derived
      from `PORTAL_SESSION_SECRET` → `GUARD_ORG_SECRET` → committed dev default
      with a one-time server warning)_
- [x] `getSessionContext` wired through gate; `roles` matcher in policy engine
      _(the SDK hook is wired and genuinely sent, but it is a **claim**: the new
      `GuardServerConfig.resolveSession` re-derives identity from the signed
      cookie server-side and that is what policy matches and the log records; a
      claim that disagrees is written into the audit message)_
- [x] One seeded role rule (billing: `get_patient` clinical notes masked)
      _(`role-billing-notes-masked`, priority 8, carries a full copy of the
      default matrix because the transform aspect takes exactly one rule's
      matrix)_
- [ ] Review gate (Opus reviewer, suite green)
- [ ] **Commit: `feat: role-scoped policies with mock identity`**

## Phase 7 — Polish, deploy, submit

- [ ] Root README: pitch, architecture diagram, threat model summary,
      `registerTool` excerpt, quickstart verified from a clean clone,
      screenshots
- [ ] `packages/sdk/README.md`: 15-minute integration guide (written so an
      agent could follow it)
- [ ] Deploy portal to Render (seed-on-boot verified; note/mitigate free-tier
      cold starts); deploy console to Vercel; envs set; CORS verified
- [ ] Full demo-path rehearsal (docs/05 script) in **ChatGPT in-app browser**
      and Chrome+flag against the live URLs
- [ ] Record + edit demo video (< 3 min, audio) per `09-demo-and-submission.md`;
      upload to YouTube, Public
- [ ] Draft submission text (four required points, `02-challenge-requirements.md`)
- [ ] Verify repo: public, license detected in About, no secrets in history
- [ ] Submit on Devpost with live URL + credentials + video + repo
- [ ] **Commit: `docs: final README + submission assets` and tag `v1.0.0`**

---

## Deferred / future work (mention in README, do not build)

- Real SSO/OIDC; NER-based name detection; websocket live streams; response
  schema contracts per tool; anomaly detection on log patterns; Chrome
  extension posture attestation.

---

## Work Log

_Claude Code: append dated entries here. Format: date — phase — what was done,
what's next, deviations/decisions._

- 2026-08-29 — Pack created. No code yet. Next: Phase 0.
- 2026-08-29 — Phase 0 complete. Monorepo scaffolded (pnpm 10.15.0, Next
  15.5.24, React 19.2.8, zod 3.25.76, vitest 4.1.11, TS 5.9.3, Tailwind v4,
  ESLint 9 flat config). Suite: 9 test files / 73 tests green, typecheck +
  lint green, both apps boot (3000/3001). Shared schemas reviewed by Fable
  (approved): adds `PolicyDocumentSchema` (version + defaultAction flag) and
  two optional LogEntry fields (`session`, `message`) beyond the letter of
  docs/04 — both justified by console/Phase-6 needs. Apps hand-written
  instead of create-next-app (workspace conflicts). Sub-agent dispatch uses
  general-purpose agents with model override since `.claude/agents/`
  definitions only register at session start. Next: Phase 1 (portal +
  raw WebMCP).
- 2026-08-29 — Phase 1 complete (portal + raw WebMCP). 16 test files / 195
  tests green; Opus review APPROVED. **WebMCP discrepancy vs docs/08 (trust
  the browser):** Chromium 151 invokes `execute(input)` with NO second
  options argument, despite `webmcp-types` declaring `(input, {signal})` —
  all 7 tools were crashing on destructure; fixed with `ctx?.signal`.
  **Local e2e verification unlocked:** snap Chromium 151 exposes
  `document.modelContext` under `--enable-features=WebMCP`;
  `scripts/webmcp-e2e.mjs` (CDP harness, orchestrator-authored) lists/calls
  tools and screenshots pages headlessly. All 7 tools verified callable
  end-to-end; before-captures in docs/captures/phase1-before/ (raw SSNs in
  search/get/export output, silent delete of LM-100060, UI screenshots).
  Reviewer polish notes carried forward: dead `SITE.tagline`, faker-bump
  fragility of the determinism test (address before Phase 3), untested
  status store, Render `$PORT` + Next ESLint plugin (Phase 7). Next:
  Phase 2 (SDK core).
- 2026-08-29 — Phase 2 complete (SDK core: wrap, gate, log). 29 files / 552
  tests green; Fable review APPROVED. Three parallel/serial sub-agent tasks:
  (A) storage adapters + server + policy engine, (B) browser SDK, (C) portal
  migration + Agent Activity drawer. Orchestrator pre-added
  `GateResponse.callId` + `GateRequest.toolTags` to the wire contract and
  pre-wired all package deps (single `pnpm install`) to avoid lockfile races
  between parallel agents. Deviations/decisions of record: log verdict
  vocabulary is the GateVerdict enum (no "transformed" — console derives it
  from `dataClasses.length`); `/gate`+`/transform` unauthenticated by design
  (host-app session is the boundary; documented in server.ts); missing
  GUARD_* env vars fall back to obviously-insecure dev defaults with a
  server warning (clean-clone quickstart; README must disclose); server
  tests import storage-memory relatively (formalize as devDependency
  later); SDK carries no webmcp-types dep (structural types; literal
  registerTool call is in webmcp.ts with the host passed as a parameter
  named `document`). Phase 5 needs a non-admin `/policies/effective`
  endpoint for registration-time policy fetch. Deny path verified: curl,
  headless-Chromium tool call (patient survived), and the audit log all
  agree. Next: Phase 3 (classification/tokenization/detokenization).
- 2026-08-29 — Phase 3 complete (data controls). 45 files / 877 tests green;
  Fable review APPROVED (crypto reviewed line-by-line: class-bound HMAC,
  AES-GCM with token-as-AAD, honest 32-bit-truncation note, no
  detokenization before an allow verdict, reveal-audited-before-answering).
  Deviations of record: (1) `list_appointments` now tagged
  `["read","phi"]` — with `read` alone the seeded transform rule never
  matched and patient names/MRNs leaked in the clear; schedule fields stay
  untransformed so the "not redaction-happy" beat survives. (2) Seeded
  default policy sets `email: mask` (docs/05 says passthrough) — emails
  embed patient names and would undo name tokenization; one-line revert if
  unwanted. (3) Tools return structured objects with a `summary` field (the
  classifier needs real keys; SDK stringifies for the agent). (4)
  `insurance*` keys all classify as insurance_id, so carrier names
  tokenize — conservative. Known gaps (documented, acceptable):
  `export_patients` CSV only partially protected (Phase 5 justification
  gate is the real control; structured export rows are future work); no
  free-text regex for address/insurance_id; bare first names in prose
  unmatched. Phase 4 console was built in parallel (sibling package, no
  conflicts) and verified live against the real API. Next: Phase 4 gate +
  commit, then Phase 5.
- 2026-08-29 — Phase 4 complete (console). Opus review gate REQUESTED
  CHANGES with two genuine findings, both fixed by the orchestrator with
  regression tests: (1) the log "transformed" badge and dashboard card
  claimed transformation when the classifier had merely *found* classes —
  badge now requires a real before/after payload difference, card renamed
  "Sensitive data handled" (storage's `stats.transformed` counts classified
  calls; renaming was truthful and cheaper than changing both adapters);
  (2) `ToolMatcherSchema` accepted `tools: []`, which the builder
  round-tripped into match-everything — now rejected at the schema.
  Trivia also fixed: app id shown in Settings About (read off the newest
  log entry), stale comment, dead tagline. Reviewer verified live: CORS
  exact-origin, 401 handling, masked-then-audited reveal, byte-identical
  policy round-trip, live-edit with no redeploy. 880 tests green.
  SUBMITTABLE CHECKPOINT reached. Next: Phase 5.
- 2026-08-29 — Phase 5 built (posture, confirmation, justification). 50 files
  / 1068 tests green; typecheck + lint clean. Awaiting the Fable review gate.
  **Seed change of record:** `delete-patient-deny-temp` is **deleted** from
  `DEFAULT_POLICY_RULES`; `export-requires-justification` (40 chars) and
  `destructive-requires-confirmation` are now enabled; the `posture-*` pack is
  seeded disabled. Seeding only runs on an empty store, so an existing
  `apps/portal/data` keeps the old policy — wipe it (or edit in the console) to
  pick the new pack up. Decisions/deviations: (1) the audit record stores
  `justification` (text, existing column) plus a new
  `justificationVerdict: {verdict, reason}` rather than one nested object —
  that is exactly the shape the console's `readJustification` already reads
  defensively, and it keeps pre-Phase-5 rows meaningful; the SQLite adapter
  gained a guarded `ALTER TABLE` migration because `CREATE TABLE IF NOT EXISTS`
  cannot widen an existing table. (2) `GET /policies/effective` is
  **unauthenticated**, like `/gate` — the SDK needs it from the page before
  registration; it answers with two booleans and a number, leaks no rule
  internals, and `effective` joined `reorder` in `RESERVED_RULE_IDS` so no rule
  can shadow the route. (3) A confirmation id is consumed **before** it is
  validated, so a replay, an expired replay and a tampered replay all destroy
  it. (4) A registration-time policy-read failure registers the tool
  **without** injection (availability over enforcement at the schema layer; the
  gate still enforces). (5) The SDK now owns an `AbortController` per
  registration, chained to the host's signal, because re-registration is
  abort-then-register. (6) UA parsing lives in
  `@webmcp-guard/shared/user-agent` so SDK and server derive identical brands.
  **WebMCP discrepancy #2 (trust the browser):** Chromium 151 *keeps the
  existing tool* when a live tool name is registered again, so the replacement
  must be built only after the old registration is aborted — registering first
  left the page on the stale schema forever. Caught by the headless e2e run,
  fixed, and now covered by regression tests. E2E on a fresh data dir: export
  blocked → instructive message → justified export returns CSV with the
  justification + pass verdict in the log; the `delete_patient` modal driven
  both ways over CDP (decline → patient intact, approve → deleted, log shows
  the human-confirmed allow); the same confirmation id replayed with curl →
  deny; `posture-deny-unknown-agent` toggled on → headless Chromium denied →
  toggled back off; policy flip re-registered `export_patients` in the live
  page within ~30 s. Modal capture in `docs/captures/phase5/`. Stretch items
  (LLM evaluator implementation, masked-at-rest UI) not built — the evaluator
  *interface* and config plumbing are. Next: Fable review gate, then Phase 6/7.
- 2026-08-29 — Phase 5 Fable review APPROVED (confirmation module + gate
  wiring read line-by-line: burn-before-validate, args-hash binding,
  consume-even-when-stale, justification stripped before detokenization,
  vault unreachable pre-allow). 1068 tests green; committed. Accepted
  deviations: flat `justification` + `justificationVerdict` log fields;
  non-admin `/policies/effective` (4 primitives, /gate trust position);
  confirmation ids not session-bound; confirmation+justification combo on
  one rule inexpressible (action union — future work). Ops note: GitHub
  repo creation and Render/Vercel deploys are blocked on user
  credentials — consolidated ask planned after Phase 6. Next: Phase 6
  (roles — small; engine `roles` matcher exists since Phase 2).
- 2026-08-29 — Phase 6 built (role-scoped policies with mock identity). 54 files
  / 1138 tests green; typecheck + lint clean. Awaiting the review gate.
  **The design decision of record:** `GateRequest.sessionContext` (the SDK's
  `getSessionContext`) is a *claim* from the page, so trusting it for role-scoped
  policy would let anyone with devtools pick their own role. New optional
  `GuardServerConfig.resolveSession(request)` resolves the session server-side;
  when configured, its answer is what the policy engine matches `match.roles`
  against **and** what the audit entry records. Contract: an answer wins over the
  claim; `undefined` means "this host has no session here" and falls back to the
  claim; a throw or a non-session answer records **no** identity (a resolver
  failure is not permission to believe the page) — all three are tested. A
  disagreement between claim and resolver is appended to the log entry's message.
  Portal wiring: `apps/portal/lib/session/` (personas, signed cookie, browser
  reader), `POST /api/session` (mock login), a header `<select>` persona switcher
  in the root layout, and `resolveSession` in `lib/guard/server.ts` — which never
  returns `undefined`, so in this deployment the page's claim is never acted on.
  Cookie: `base64url(userId.role.issuedAt).base64url(HMAC-SHA256)`, httpOnly,
  SameSite=Lax, Secure behind https, **no expiry** (documented: mock login, real
  SSO out of scope per docs/01); signing key derived (domain-separated HMAC) from
  `PORTAL_SESSION_SECRET` → `GUARD_ORG_SECRET` → committed dev default with its
  own one-time warning. A second, unsigned `lakeside_persona` cookie exists only
  so `getSessionContext` has something real to read; the layout also stamps
  `data-session-*` on `<body>` as the first-load bootstrap. Seed: new
  `role-billing-notes-masked` (enabled, priority 8, `{roles:["billing"],
  tools:["get_patient"]}`) carrying a **full copy** of `phi-transform-default`'s
  matrix with `free_text_phi: "mask"` — the transform aspect takes exactly one
  rule's matrix, so a delta rule would silently drop every other row. E2E on a
  fresh data dir (headless Chromium 151, one session): as the default Dr. Reyes
  `get_patient` returned notes with `tok_name_*`/`tok_mrn_*` spans; switching to
  Sam Levin **through the header dropdown** set the cookie, flipped the role chip
  to `billing`, and the same call came back with every note body — and the
  free-text `summary` — as `▪▪▪` while demographics stayed tokenized/bracketed
  exactly as before; `search_patients` was unaffected (the rule is scoped to
  `get_patient`). Log entries carry `session {userId, role}` and the deciding
  rule id. Also verified by curl: a spoofed `sessionContext` under a billing
  cookie still gets billing policy and logs "The page claimed … the host
  application resolved …"; a billing claim with no cookie gets physician policy;
  a tampered signature falls back to the default persona. Capture:
  `docs/captures/phase6/header-persona-switcher.png`. Deviations/notes: (1) the
  masked whole-field rule also blanks `get_patient`'s `summary` string, since
  that is free text with PHI in it — correct per Phase 3 semantics, and worth a
  sentence in the video rather than a surprise; (2) mock login is a header
  switcher, not a `/login` page; (3) `apps/portal/data` was wiped after the run.
  Next: review gate, then Phase 7.
