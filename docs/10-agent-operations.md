# 10 — Agent Operations: Models, Sub-Agents, Review, and Testing

These are the operational rules for how Claude Code runs this project. The
main chat is the **orchestrator**; almost all implementation happens in
**sub-agents**. Reviews and tests gate every phase.

## Model routing

| Role | Model / effort | Used for |
|---|---|---|
| Orchestrator (main chat) | **Fable** (`claude-fable-5`) | Task decomposition, sequencing, integration decisions, resolving ambiguity in the docs, critical reviews, work-log upkeep. Writes little code itself. |
| Implementer — standard | **Opus** (`claude-opus-5`), high effort / extended thinking | Simple, well-specified tasks: scaffolding, config, seed data, CRUD routes, straightforward UI, docs, tests for existing behavior. |
| Implementer — hard | **Opus** (`claude-opus-5`), **max effort** (ultrathink / maximum thinking budget) | Difficult or subtle tasks: policy engine, tokenization + vault + detokenization, the gate/transform pipeline, confirmation-flow state, WebMCP registration lifecycle, CORS/auth. |
| Reviewer — routine | **Opus** (`claude-opus-5`) sub-agent | Reviews of routine work; runs the test/typecheck/lint suite. |
| Reviewer — critical | **Fable** (main chat directly, or a Fable sub-agent) | Reviews of security-critical work (see list below) and end-of-phase integration reviews. |
| Escalation solver | **Fable** (`claude-fable-5`) sub-agent | Problems an Opus reviewer or implementer cannot solve. |

Mechanics: define these as custom agents in `.claude/agents/` with `model:` in
the frontmatter (`implementer`, `implementer-hard`, `reviewer`, `solver`), and
set thinking effort via the agent prompt ("think hard" for standard, maximum
thinking for hard tasks). Create these agent definitions in Phase 0. If exact
model strings or effort controls differ in the installed Claude Code version,
match the *intent* of this table and note the substitution in the work log.

## Sub-agent dispatch rules (orchestrator)

1. Default to delegating. The orchestrator implements directly only for
   one-file trivial fixes; everything else goes to a sub-agent.
2. Classify each task before dispatch: **standard** (clear spec in the docs,
   low blast radius) → Opus/high; **hard** (novel logic, cross-package
   surface, security-relevant, or anything on the critical list) → Opus/max.
   When unsure, dispatch as hard.
3. Every dispatch prompt must include: the relevant doc section(s) by path,
   the acceptance criteria, the requirement to write/extend tests in the same
   task, and the instruction to run `pnpm test && pnpm typecheck && pnpm lint`
   before reporting done.
4. Sub-agents cannot spawn sub-agents — all handoffs route through the
   orchestrator.
5. Parallelize freely where tasks don't share files (e.g., console UI vs SDK
   internals); never two sub-agents in the same package concurrently.

## Review gates

Every completed task is reviewed before its work is considered done; every
phase ends with an integration review before the phase commit.

**Critical list — always Fable-reviewed:** token vault + crypto, tokenization/
detokenization, classifier correctness, policy engine + rule matching, the
gate/transform pipeline and wire contract, session/auth/admin-token handling,
CORS config, confirmation-id flow, anything in `@webmcp-guard/shared` schemas.
Everything else: Opus reviewer.

Reviewer duties (both tiers):

1. Read the diff against the relevant docs; flag spec deviations.
2. Run the full suite: `pnpm test && pnpm typecheck && pnpm lint`. A red suite
   is an automatic fail — no exceptions, no "will fix later."
3. Spot-check behavior (call the route, run the seed, load the page) where
   tests can't cover it.
4. Verdict in one of three forms: **approve**, **request changes** (with a
   concrete list, back to the original implementer tier), or **escalate**.

## Escalation chain

When an Opus reviewer (or implementer) hits a problem it cannot solve or
confidently diagnose:

1. It stops and reports **escalate** to the orchestrator with: the failing
   behavior, what was tried, relevant files, and its best hypothesis.
2. The orchestrator spawns a **Fable solver sub-agent** with that context. The
   solver diagnoses and either fixes the hard core directly or produces an
   exact remediation plan.
3. When the hard part is solved, the solver hands back through the
   orchestrator to a **regular Opus sub-agent** to finish the remaining
   routine work (cleanup, tests, docs) — Fable capacity is not spent on
   routine follow-through.
4. The touched code then goes through a **Fable review** (an escalation marks
   the area as critical by definition), and the escalation is recorded in the
   work log: trigger, root cause, resolution.

Loop guard: if the same task escalates twice, the orchestrator stops
dispatching and re-plans the task itself (usually the spec, not the code, is
the problem).

## Test suite — built as we go, never as a phase

- **Framework:** Vitest, colocated `*.test.ts` in each package; root scripts
  `pnpm test`, `pnpm typecheck`, `pnpm lint` run everything. Set up in Phase 0
  with one passing placeholder test so the gate exists from the first commit.
- **Definition of done for any task includes its tests.** New logic ships with
  tests in the same sub-agent task; bug fixes ship with a regression test that
  fails before the fix.
- **Must-cover map** (owned by the phase that builds the feature): classifier
  detectors incl. negatives (Ph3), token determinism + round-trip (Ph3),
  transform matrix (Ph3), policy rule ordering + verdict matrix (Ph2), storage
  adapter contract run against both memory and sqlite (Ph2), wire-schema
  validation (Ph0/2), gate endpoint behavior via route-handler tests (Ph2/5),
  confirmation-id single-use (Ph5), role matching (Ph6).
- **Not required:** UI component/e2e tests. A short node smoke script hitting
  the deployed API (`scripts/smoke.mjs`) is a Phase 7 nice-to-have.
- **Commits:** no commit with a red suite. Phase-boundary commits happen only
  after the phase's integration review approves.
