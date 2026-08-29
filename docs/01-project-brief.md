# 01 — Project Brief

## Name

**webmcp-guard** (decided). Repo name `webmcp-guard`, npm scope
`@webmcp-guard/*`, product prose "WebMCP Guard." Use consistently in the
README, console UI, and demo video.

## One-line pitch

WebMCP Guard is a drop-in SDK that wraps a website's WebMCP tools with enterprise
security controls — policy-based authorization, agent/browser posture checks,
and sensitive-data tokenization — managed from a web console, so organizations
can open their internal apps to AI agents without opening their data.

## The problem

WebMCP lets any website expose structured tools to AI agents. That's exactly
what enterprises want for productivity — and exactly what terrifies their
security teams. An agent with tool access to an internal app can read PII,
export records, and take destructive actions, and everything it reads flows
into a third-party LLM context. Today, every company that wants agent access to
a sensitive internal app must hand-build authorization, data redaction, and
audit logging around every single tool. Nobody will do that well, and most
won't do it at all — they'll just block agents.

## The solution

A generic (not healthcare-specific) SDK that sits between the site's WebMCP
tool definitions and the browser's model context:

1. **Wrap, don't rewrite.** Developers register tools through WebMCP Guard with
   the same shape as `document.modelContext.registerTool()`. WebMCP Guard applies
   the security pipeline and registers the wrapped tool with the browser.
2. **Data controls.** Tool inputs and outputs are scanned for sensitive data
   (SSNs, MRNs, names, DOBs, contact info, etc.). Sensitive values are replaced
   with **deterministic tokens** (e.g. `tok_ssn_8f3a2c`) before they reach the
   agent. The same value always yields the same token, so the agent can still
   reason about identity and equality ("this is the same patient") without ever
   seeing the value. When the agent passes a token back into another tool call,
   the server-side runtime swaps in the real value. Some classes can instead be
   replaced with contextual generalizations (DOB → age bracket).
3. **Posture controls.** Before a tool executes, WebMCP Guard checks environment
   signals — browser brand/version (UA Client Hints), secure context, origin
   isolation, best-effort agent identification — against policy. Gated tools
   can additionally require the agent to supply a written justification
   (injected as a required schema field), which is logged and can optionally be
   evaluated by an LLM before the action is allowed.
4. **Access control.** Policies can scope tools and data classes by the host
   app's user role/session (demo uses mock roles; real SSO is explicitly out of
   scope for the hackathon).
5. **Console + audit.** A management console where admins define policies
   (which agents, which tools, which data classes, which actions) and review a
   complete audit trail of every agent tool call: inputs, matched rules,
   transformations applied, and outcomes.

## The demo

**Lakeside Medical**, a convincing but entirely fictitious patient portal
(Next.js) with realistic synthetic records and WebMCP tools to search, read,
update, export, and delete patients. The demo shows the same agent task
before/after WebMCP Guard: without it, the agent freely reads SSNs and deletes a
record; with it, PII arrives tokenized, the delete is blocked pending
justification, and every step appears in the console's audit log — yet the
agent still completes legitimate work ("find Ms. ⟨token⟩'s upcoming visits and
add a note") end to end.

## Why this wins on the judging criteria

- **WebMCP Leverage.** WebMCP Guard doesn't just use `registerTool` — it programs
  *against* the whole API: wrapping registration, rewriting `inputSchema` to
  inject justification fields, setting `annotations` (`readOnlyHint`,
  `untrustedContentHint`) from policy, unregistering tools via `AbortSignal`
  when policy revokes them, and reacting to `toolchange`. It treats WebMCP as a
  platform, which few entries will.
- **Execution.** Two polished apps (portal + console) plus a documented,
  installable SDK — a complete product experience, not a proof of concept.
- **Potential Impact.** A credible, specific case: regulated industries cannot
  adopt agent-native web apps without exactly this layer. The submission text
  can speak to this with real enterprise-security fluency.
- **Creativity & Ambition.** Almost every entry will be an agent-*enabled* app.
  This is infrastructure that makes agent-enabled apps *deployable* — a
  different category. The deterministic tokenization trick (agents reasoning
  over data they can't see) is a genuinely novel demo moment.

## Explicit non-goals (hackathon scope)

- Real SSO / OIDC integration (mock role-based login only).
- Claiming client-side wrapping defends against a malicious *user* — it
  defends data from the *agent/LLM*; see the threat model in
  `03-architecture.md`.
- ML/NER-based entity detection (pattern + field-name classification only;
  note NER as future work).
- Multi-tenant SaaS anything. Single org, self-hosted, no external services.
