# 06 — Management Console Requirements

Next.js app, stateless client of the portal's `/api/guard/*` admin
endpoints (bearer token entered on a simple login screen, held in memory /
sessionStorage). Aesthetic: security-product dark-ish admin UI, clearly
distinct from the clinical portal. Name it in-product ("WebMCP Guard Console").

Priority order within this app: **Logs → Policies → Dashboard → Settings.**
Logs sell the story even if the policy editor ends up simpler than planned.

## 1. Audit log (build first)

- Reverse-chron table: timestamp, app, tool, agent (best-effort id + browser),
  verdict badge (allowed / denied / transformed / confirmed / justified),
  data classes touched, rule(s) matched, duration.
- Filters: tool, verdict, data class, agent, time range; auto-refresh toggle
  (poll every few seconds — no websockets).
- Detail drawer per entry:
  - matched rules with links to the policy editor;
  - posture snapshot as reported;
  - **before/after payload view**: original args/result vs what the agent
    received, with sensitive originals masked by default and a "reveal"
    action (admin-token gated, and revealing is itself logged);
  - the justification text and evaluator verdict when applicable.

## 2. Policy editor

- Ordered rule list with enable/disable toggles, drag or arrow re-prioritize.
- Rule editor as a structured builder, not free-form JSON (JSON view as an
  escape hatch): WHEN (app / tools-or-tags / agent matchers / roles / data
  classes) THEN (action, with per-action fields: deny message, min
  justification length, per-class transform matrix).
- The per-class transform matrix is the visual centerpiece: rows = data
  classes, columns = tokenize / mask / contextualize / passthrough.
- Validation via the shared zod schema; changes take effect on the next tool
  call (and on SDK policy refresh for registration-level effects) — say so in
  the UI ("live in seconds, no redeploy").

## 3. Dashboard

- Stat cards: tool calls (24h), blocked, transformed, unique agents.
- Two simple charts (recharts): calls over time stacked by verdict; top tools.
- Recent activity feed (last 10 log entries, links into the log).

## 4. Settings

- Read-only display of configured detectors/data classes and token format.
- Toggle for the posture rule pack and the LLM evaluator (when configured).
- "About this deployment": app id, endpoint URL, storage adapter in use —
  reinforces the bring-your-own-database story.

## Non-goals

- User management, RBAC for admins, multi-org — out of scope; single admin
  token.
- Historical analytics beyond the simple charts.
