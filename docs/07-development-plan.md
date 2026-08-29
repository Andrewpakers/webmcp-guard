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

- [ ] Console shell: token login, layout, nav
- [ ] Audit log table + filters + auto-refresh + detail drawer with
      before/after payloads and gated reveal (reveal is logged)
- [ ] Policy list + structured rule editor + per-class transform matrix +
      enable/disable + reorder; JSON escape hatch
- [ ] Dashboard: stat cards, 2 charts, recent activity
- [ ] CORS + admin-token auth on portal admin routes
- [ ] Live-edit proof: change a transform in console → next agent call behaves
      differently, no redeploy
- [ ] Review gate (Opus reviewer; Fable spot-check on auth/CORS, suite green)
- [ ] **Commit: `feat(console): logs, policies, dashboard`**
- [ ] ☑ Checkpoint: from here the project is submittable. Deploy early (see
      Phase 7 deploy items) rather than waiting.

## Phase 5 — Posture, confirmation, justification

- [ ] Posture snapshot in SDK (UA Client Hints + fallback, secure context,
      best-effort agent id) and posture matchers in the policy engine
- [ ] Posture rule pack seeded but **disabled by default** (judge-safety);
      console toggle
- [ ] `require-confirmation` flow: in-page modal, one-time confirmation id,
      decline returns policy explanation to agent
- [ ] `require-justification`: schema injection of required `justification`
      field on gated tools; heuristic evaluator; justification + verdict in
      logs/console
- [ ] Stretch (skip if behind): pluggable LLM evaluator behind `LLM_API_KEY`,
      heuristic fallback on error
- [ ] Stretch (skip if behind): masked-at-rest UI fields with logged
      click-to-reveal (anti-circumvention demo, see docs/05 + threat model)
- [ ] Review gate (**Fable** — critical phase, suite green)
- [ ] **Commit: `feat: posture checks, confirmation, justification`**

## Phase 6 — Roles (optional; cut first if behind)

- [ ] Mock login (3 personas, signed session cookie w/ role)
- [ ] `getSessionContext` wired through gate; `roles` matcher in policy engine
- [ ] One seeded role rule (billing: `get_patient` clinical notes masked)
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
