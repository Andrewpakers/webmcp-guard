# Deploying WebMCP Guard's demo apps

Two deployments, per `docs/03-architecture.md`:

| App                                                       | Host                         | Why                                                                                                           |
| --------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/portal` (Lakeside Medical + the guard API + SQLite) | **Render**, Node web service | SQLite needs a long-lived process and a real filesystem; serverless filesystems are ephemeral per-invocation. |
| `apps/console` (WebMCP Guard Console)                     | **Vercel**                   | Stateless client of the portal's guard API.                                                                   |

## 1. Portal → Render

1. Push this repo to GitHub (public — challenge requirement).
2. In the Render dashboard: **New → Blueprint**, point it at the repo. Render
   reads `render.yaml` and creates the `webmcp-guard-portal` web service with
   generated values for `GUARD_ORG_SECRET`, `GUARD_VAULT_KEY`,
   `GUARD_ADMIN_TOKEN`.
3. After the first deploy, note the service URL (e.g.
   `https://webmcp-guard-portal.onrender.com`) and verify:
   - `/patients` shows 60 seeded patients (seed-on-boot ran);
   - `/api/guard/policies` with `Authorization: Bearer <GUARD_ADMIN_TOKEN from
the dashboard>` returns the seeded policy.
4. Copy `GUARD_ADMIN_TOKEN` from the service's environment tab — it is the
   console login credential and goes on the Devpost submission form.
5. Free-tier instances sleep; either upgrade to the smallest paid instance for
   judging week or note the cold-start delay in the submission text.

## 2. Console → Vercel

1. In Vercel: **Add New Project** → import the same GitHub repo.
2. Settings:
   - **Root Directory**: `apps/console` (enable "Include source files outside
     of the Root Directory" — the console imports `@webmcp-guard/shared` from
     the workspace).
   - Framework preset: Next.js. Vercel detects pnpm from the lockfile.
   - **Environment variable**: `NEXT_PUBLIC_GUARD_API_URL` =
     `https://<portal-host>/api/guard`.
3. Deploy, note the console URL.

## 3. Connect the two (CORS)

Back on Render, set `GUARD_CONSOLE_ORIGIN` to the console's exact origin
(e.g. `https://webmcp-guard-console.vercel.app`, no trailing slash) and
redeploy. The guard API echoes exactly that origin in
`Access-Control-Allow-Origin` on the admin routes — never `*`.

## 4. Smoke test from a clean device

- Portal cold URL → patients render, WebMCP chip green in a WebMCP browser.
- Console `/login` with the admin token → logs render.
- Agent flow in ChatGPT's in-app browser or Chrome (149+,
  `chrome://flags/#enable-webmcp-testing`): search patients → tokens; export →
  justification demanded; delete → in-page confirmation modal.

## Secrets model (honest notes)

- Missing `GUARD_*` env vars fall back to **published, obviously-insecure dev
  defaults** so a clean clone boots with zero setup. Anything deployed must set
  real values — the Render blueprint generates them.
- `/gate` and `/transform` are deliberately unauthenticated at the guard layer:
  they sit inside the host app and share its session boundary. The guard
  governs the agent channel, not the human (see the threat model in
  `docs/03-architecture.md`).
