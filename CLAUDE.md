# CLAUDE.md — WebMCP Guard (WebMCP Challenge entry)

WebMCP Guard is an SDK that wraps a website's WebMCP tools to add enterprise
security controls (policy, posture, data tokenization, audit logging) plus a
management console. It is being built for the Devpost WebMCP Challenge,
**deadline Sep 3, 2026 @ 1:00 PM PDT**.

## Read these first

- `docs/07-development-plan.md` — the phased plan. Find the first unchecked item
  and continue from there.
- `docs/03-architecture.md` — system design and monorepo layout. Do not deviate
  from the package boundaries without noting why in the work log.
- `docs/02-challenge-requirements.md` — hard submission requirements. Nothing in
  this file is negotiable.
- `docs/10-agent-operations.md` — how work gets done here: model routing,
  sub-agent dispatch, review gates, escalation, testing discipline. Binding on
  every session.

The other docs (`01`, `04`, `05`, `06`, `08`, `09`) are detailed requirements
per component. Read the relevant one before starting each phase.

## Operating model (summary — full rules in docs/10)

- The main chat (Fable) orchestrates and reviews; it delegates nearly all
  implementation to sub-agents.
- Standard tasks → Opus sub-agent with high effort. Hard/security-critical
  tasks → Opus sub-agent at max effort.
- Every task is reviewed before it counts as done: routine work by an Opus
  reviewer, security-critical work and phase boundaries by Fable. Reviewers
  run `pnpm test && pnpm typecheck && pnpm lint`; red suite = automatic fail.
- Stuck Opus reviewer/implementer → escalate to a Fable solver sub-agent →
  solved work hands back to a regular Opus sub-agent to finish → Fable review.
- Tests are written in the same task as the feature, never deferred.

## Working conventions

- **Update the plan as you go.** Check off items in `docs/07-development-plan.md`
  when complete. Append a dated entry to the Work Log section at the bottom of
  that file at the end of every session summarizing what was done, what's next,
  and any deviations from the docs.
- **Commit discipline.** Commit after every phase and after every major
  implementation step within a phase. Use conventional commits
  (`feat:`, `fix:`, `docs:`, `chore:`). Never leave uncommitted work at the end
  of a session. Do not push force. Do not commit secrets — use `.env.local` and
  keep `.env.example` current.
- **Ship over polish, until Phase 7.** The plan is ordered so the project is
  submittable from the end of Phase 4 onward. If a task is dragging, stub it,
  note it in the work log, and move on. Deadline beats completeness.
- **Stack constraints.** Next.js (App Router) + React + Node + TypeScript only.
  No Python, no external SaaS dependencies (no Supabase/Firebase/etc.).
  SQLite (`better-sqlite3`) for persistence via the storage adapter interface.
  Tailwind for styling. `pnpm` workspaces for the monorepo.
- **The literal WebMCP call must be visible in the repo.** The challenge
  requires the repository to contain a `document.modelContext.registerTool({...})`
  call. WebMCP Guard's client SDK wraps this API — make sure the underlying call is
  plainly present in the SDK source (not obfuscated or dynamically constructed),
  and add a short code excerpt of it to the repo README.
- **Feature-detect WebMCP.** Register tools via `document.modelContext` when
  available, fall back to `navigator.modelContext` (earlier explainer surface),
  and degrade gracefully (log a console warning, keep the app fully usable by
  humans) when neither exists. The app must never crash in a browser without
  WebMCP.
- **Honest security posture.** Client-side wrapping protects data from the
  *agent/LLM*, not from the human at the keyboard. Where the docs call for
  server-side enforcement (detokenization, policy fetch, logging), keep it
  server-side. Never claim in code comments, README, or UI copy that the client
  wrapper is a security boundary against the user.
- **Fake data only.** All patient data is generated. Never use real names of
  real people; the seed generator must be obviously synthetic (see
  `docs/05-demo-app-requirements.md`). Include a "demo data — all records are
  fictitious" notice in the portal UI.
- **License:** MIT, `LICENSE` file at repo root so GitHub auto-detects it (a
  challenge requirement).

## Testing WebMCP locally

1. Chrome 149+: enable `chrome://flags/#enable-webmcp-testing`, relaunch.
2. Install the "Model Context Tool Inspector" extension (Chrome Web Store) to
   list registered tools, call them manually, and drive them with prompts.
3. Final validation should also happen in ChatGPT's in-app browser, which
   supports WebMCP out of the box — that is what judges are told to use.

See `docs/08-webmcp-reference.md` for the API surface.
