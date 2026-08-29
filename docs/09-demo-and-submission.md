# 09 — Demo Video & Submission Guide

## Deployment checklist (do this at the Phase 4 checkpoint, not at the end)

- [ ] Render web service for `apps/portal` (build via pnpm, `next start`,
      Node 20+, `better-sqlite3` builds fine on Render's native environment)
- [ ] Seed-on-boot verified on Render (deploy, hit URL cold, data present)
- [ ] Env vars set: `GUARD_ORG_SECRET`, `GUARD_VAULT_KEY`,
      `GUARD_ADMIN_TOKEN`, console origin for CORS
- [ ] Vercel project for `apps/console` with `NEXT_PUBLIC_GUARD_API_URL`
- [ ] Free-tier cold starts: if the Render instance sleeps, judges' first hit
      is slow — either upgrade to the smallest paid instance for judging week
      or note the wake-up delay in the submission text
- [ ] Smoke-test the full demo path against production from a device that has
      never run the project

## Demo video (< 3:00, public YouTube, voiceover required)

Record at 1080p+, single take per segment, tight cuts. Screen: left = portal
(or ChatGPT in-app browser), right/cut-in = console. Suggested timeline:

- **0:00–0:20 — Problem.** One sentence over the portal: "WebMCP lets agents
  drive real apps — but for anything with sensitive data, that's a
  non-starter. This is a fake hospital portal; watch what an agent sees
  without controls." Show raw tool result with a visible SSN (Phase 1
  "before" capture).
- **0:20–0:40 — Introduce WebMCP Guard.** One diagram beat: "WebMCP Guard is an SDK
  that wraps your WebMCP tools with policy, posture checks, data tokenization,
  and audit — managed from a console." Show the 5-line integration diff
  (registerTool → guard.registerTool).
- **0:40–1:30 — The tokenization moment (hero segment).** Live agent chat:
  search patients → results arrive with `tok_name_…`/`tok_ssn_…`; agent
  reasons about them and passes a token back into `add_visit_note`; the note
  appears in the UI with the real patient. Voiceover nails the trick: "The
  agent never saw a name or SSN — but because tokens are deterministic, it can
  still reason about identity, and WebMCP Guard swaps the real values back in
  server-side."
- **1:30–2:05 — Teeth.** Agent tries `export_patients` → justification
  demanded and supplied → allowed and logged. Agent tries `delete_patient` →
  human confirmation modal → decline → agent gets a clean policy explanation.
- **2:05–2:40 — Console.** Audit log with before/after payloads; flip one
  policy cell (e.g. name: tokenize → passthrough) and rerun a search to show
  live policy without redeploys; 5 seconds on the dashboard.
- **2:40–3:00 — Close.** "Generic SDK, bring your own database, MIT licensed.
  This is the layer that lets regulated industries say yes to the agent-native
  web." URL + repo on screen.

Practical notes: script the voiceover word-for-word; rehearse the agent
prompts until deterministic-ish; record agent segments in ChatGPT's in-app
browser if stable, Chrome+Inspector otherwise; keep a captured backup take of
every segment.

## Submission text — outline against the four required points

1. **Why a strong fit for WebMCP:** WebMCP is the first standard interface
   between agents and web apps — which makes it the first place a security
   control plane for agents can exist. WebMCP Guard builds *on* the API surface
   itself (wrapping registerTool, rewriting schemas, driving annotations and
   unregistration from policy).
2. **Better user experience:** humans keep their app; agents get clear,
   structured tools with legible policy feedback instead of silent failures;
   admins get one console instead of bespoke controls per app.
3. **Newly possible together:** an employee and their agent can work on
   regulated data jointly — the agent handles the tedium without ever
   holding the PII, the human approves the dangerous parts in-page, and
   compliance gets a complete audit trail. Previously the only options were
   "block agents" or "leak everything."
4. **How WebMCP was implemented:** brief pipeline description (wrap →
   gate → detokenize in → execute in page → classify/tokenize out → log),
   note the honest threat model, link the SDK README.

Also prepare: 3–5 gallery screenshots (portal, tokenized agent chat, log
detail with before/after, policy matrix, dashboard), a one-line tagline, and
the demo credentials for the submission form.

## Final-hour checklist

- [ ] Video link is Public (test in incognito)
- [ ] Live URLs load cold from a fresh network
- [ ] Repo About section shows the MIT license
- [ ] Submission form complete with credentials; submitted with hours to spare
