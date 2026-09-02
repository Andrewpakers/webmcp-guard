# Devpost submission text — WebMCP Guard

Paste-ready. ~700 words in the description body. Everything here is true of the
code as committed; do not embellish before submitting.

---

## Tagline (one line)

**The security layer that lets regulated apps say yes to agents — policy, tokenization and audit, wrapped around your WebMCP tools by changing one line of code.**

---

## Description

### Why this is a strong fit for WebMCP

WebMCP is the first standard interface between agents and web applications — which makes it the first place a *security control plane* for agents can exist at all. Before WebMCP there was no chokepoint: agents drove the DOM, and there was nothing to govern.

WebMCP Guard is that control plane, and it is built *on* the API rather than merely calling it. It wraps `document.modelContext.registerTool` (with a `navigator.modelContext` fallback). It rewrites `inputSchema` from live policy, injecting a required, described `justification` argument so an agent learns a requirement from the tool list instead of from a refusal. It carries `annotations` through to the browser, and owns an `AbortController` per registration so policy can unregister a tool. Because re-registration in WebMCP is *abort-then-register*, a policy change aborts the live registration **before** building the replacement — not a style choice: Chromium keeps the *old* tool when a live name is registered again, so the intuitive order leaves the page on a stale schema forever. We found that by running real tool calls through a real WebMCP browser, along with two other spec/implementation discrepancies documented in the repo.

### How it makes the experience better

Today the honest options for an app with sensitive data are "block agents" or "leak everything." Neither is a product.

With the guard, the human keeps their app unchanged. The agent gets *legible policy feedback* instead of silent failures — every denial names the rule that produced it and says what to do next, because a model's next turn should be a better call, not a shrug. Dangerous actions surface an in-page approval modal, so the person at the keyboard decides in context. And the administrator gets one console — audit log with before/after payloads, a per-class transform matrix, live policy edits that take effect on the next call with no redeploy — instead of bespoke controls hand-built around every tool.

### What people and agents can now do together

An employee and their agent can work on regulated records *jointly*, which was previously impossible.

The demo is Lakeside Medical, a fictitious patient portal with 60 synthetic patients and seven WebMCP tools. Ask the agent to find a cohort and it comes back with `tok_name_23240732` and `tok_mrn_e53e5143` — deterministic tokens derived by HMAC under an org secret. The same value always yields the same token, including inside free-text visit notes, so the agent can tell that a note and a search hit concern the same person and act on it. Hand a token back into another tool and the server swaps in the real value before the tool runs. Dates of birth arrive as age brackets; addresses as city and state; conditions, medications and appointment times in the clear, because the guard is not redaction-happy.

**The agent does real work on data it has never seen.** The tedium is delegated, the PII never enters the model's context, the human approves the dangerous parts in-page, and compliance gets a complete audit trail.

### How WebMCP was implemented

`@webmcp-guard/sdk` wraps each tool's `execute`. Every call runs gate → (human confirmation) → your `execute` in the page → transform → result to the agent. The gate resolves ordered policy rules, checks browser/agent posture, validates one-time confirmations and written justifications, and detokenizes arguments from an encrypted vault — but only after an allow verdict, so it can never be used as a detokenization oracle. The transform half classifies the result (field names, then regex, then a host-supplied name dictionary), applies the per-class matrix, and closes the audit entry.

Enforcement is entirely server-side, in `@webmcp-guard/server`, mounted inside the host app. The browser never holds the vault, and the pipeline fails closed: if the guard cannot be reached, the result is withheld rather than returned raw.

We are equally explicit about what this does not do. It governs the agent channel, not the DOM — a person with DevTools already has the data, and an agent that actuates a revealed UI is indistinguishable from that person. Closing that last gap needs the browser or agent runtime to restrict agents to the tool channel. The repo's threat model says so in as many words, because a security product that overclaims is worse than none.

MIT licensed. Generic SDK, bring your own database via a `GuardStorage` adapter. 1,139 tests.

---

## Gallery captions (5 screenshots, in this order)

1. **`docs/captures/phase1-before/portal-patients.png`** — Lakeside Medical: a fictitious patient portal with 60 synthetic records and seven WebMCP tools. Humans use it normally; agents get the same seven tools.
2. **`docs/captures/portal-agent-activity-drawer.png`** — The Agent Activity drawer: every gate, execute, transform and block as it happens, in the page. It auto-opens the moment an agent is blocked, so the person sees why.
3. **`docs/captures/console/log-detail-drawer.png`** — One audit entry, before and after. The raw payload the tool produced, the tokenized payload the agent received, the rules that matched, and the resolved identity. Revealing a value here is itself logged.
4. **`docs/captures/console/policy-editor-matrix.png`** — The per-class transform matrix: tokenize, mask, contextualize or pass through, per data class, per rule. Edits take effect on the next agent call — no redeploy.
5. **`docs/captures/phase5/confirmation-modal.png`** — An agent asked to delete a patient. The person at the keyboard decides, in the page. The approval is single-use and bound to those exact arguments; a replay is refused and burned.

Alternates if a sixth slot is available: `docs/captures/console/dashboard.png` (call volume, denials, sensitive data handled) and `docs/captures/phase6/header-persona-switcher.png` (three mock staff roles; billing sees no clinical notes).

---

## Credentials block (for the submission form)

> Replace every `TODO` before submitting. Do not submit the committed development defaults.

```
Portal (Lakeside Medical) — the app judges should open in a WebMCP browser:
  URL:   https://webmcp-guard-portal.onrender.com/patients
  Login: none required. Use the persona switcher in the header to change role
         (Dr. Alicia Reyes / physician, Nurse Chidi Okafor / nursing,
         Sam Levin / billing). Mock identities only — no passwords, no SSO.

WebMCP Guard Console — the admin view of the same deployment:
  URL:   https://webmcp-guard-console.vercel.app
  Login: paste the admin token on the connect screen.
  Admin token: TODO-paste-from-render   (the deployment's GUARD_ADMIN_TOKEN —
               Render dashboard -> webmcp-guard-portal -> Environment)

Repository: https://github.com/Andrewpakers/webmcp-guard  (make public before submitting)
Demo video: TODO-until-video  (public YouTube, under 3:00, with audio)

To enable WebMCP: Google Chrome 149+ with chrome://flags/#enable-webmcp-testing
enabled and a full relaunch, or open the portal in ChatGPT's in-app browser.
Without WebMCP the portal still works normally for humans and the header chip
says so.
```

---

## Cold-start note (include verbatim in the submission text)

> **Please give the first page load up to a minute.** The portal runs on a free
> Render instance that sleeps when idle, so the first request after a quiet
> period wakes the container before it answers. The database is ephemeral across
> restarts by design — schema, the 60 demo patients and the default policy are
> all seeded on boot, so a cold instance always comes up complete. Everything
> after the first load is fast.

---

## Pre-submit checks

- [ ] Every `TODO-until-deploy` above replaced with a real value.
- [ ] Video is Public (test the link in an incognito window).
- [ ] Portal and console both load cold from a network that has never seen them.
- [ ] Repo is public and the About sidebar shows the MIT license.
- [ ] `document.modelContext.registerTool(` visible in the repo and quoted in the README.
- [ ] Deployed admin token is **not** `dev-only-admin-token--do-not-deploy` or `dev-admin-token-change-me`.
- [ ] Root README's "Deployed URLs" table filled in to match the form.
