# 02 — Challenge Requirements (Devpost: The WebMCP Challenge)

Source: https://webmcp.devpost.com/ (verified Aug 29, 2026). Re-check the
Rules and Resources tabs before submitting; this summary is not a substitute
for the official rules.

## Deadline

**Wednesday, September 3, 2026 @ 1:00 PM PDT.** Hosted by OpenAI, managed by
Devpost. $35,000 total; the top 10 submissions each win $3,000 cash plus
sponsor prizes (Codex Micro, ChatGPT Pro, Cloudflare/Vercel/Render/Netlify
credits, etc.).

## What to build

"A WebMCP-powered web app that imagines and explores the future of the open
web — where humans and agents can interact, collaborate, and create together."
The framing to hit: an app that becomes *meaningfully better* when people and
their agents can use it together.

## Required submission artifacts

1. **Working live URL** that judges can access using **ChatGPT's in-app
   browser** or **Google Chrome with WebMCP enabled**
   (`chrome://flags/#enable-webmcp-testing`).
   - Any host is allowed (ChatGPT Sites, Cloudflare, Vercel, Render, Netlify,
     Shopify, or other).
   - Authentication is allowed; if used, credentials go on the submission form.
     For WebMCP Guard: provide demo credentials for the portal roles and for the
     console admin login.
2. **Text description** that explains:
   - Why the use case is a strong fit for WebMCP
   - How it creates a better user experience
   - What people and agents can do together that was difficult or impossible
     before
   - Briefly, how WebMCP was implemented
3. **Demo video**: under 3 minutes, public YouTube link, with audio, showing a
   clear demo of what was built and how WebMCP was used.
4. **Public code repository** (GitHub/GitLab/Bitbucket) containing:
   - All source code, assets, and instructions required to run the project
   - An **open source license file** that is detectable by the platform and
     visible at the top of the repo page (About section) — use MIT and a
     standard `LICENSE` file at root
   - The repository must contain a literal WebMCP tool registration, i.e. code
     of the form:

     ```js
     document.modelContext.registerTool({
       name: "search_products",
       description: "Search the product catalog",
       inputSchema: { /* ... */ },
       execute: async (input) => { /* ... */ }
     });
     ```

     WebMCP Guard wraps this API, so ensure the underlying
     `document.modelContext.registerTool(...)` call is plainly visible in the
     SDK source and excerpted in the README.

## Judging criteria (verbatim themes)

| Criterion | What judges ask |
|---|---|
| WebMCP Leverage | How thoroughly and skillfully does the project use WebMCP? Genuine, working, non-trivial implementation? |
| Execution | A working/runnable project with a complete, coherent product experience — not just a technical PoC? |
| Potential Impact | A credible, specific case for solving a real problem for a real audience, actually addressed by what's demonstrated? |
| Creativity & Ambition | Novel concept, different from existing concepts? |

Judges include people from Cloudflare, Shopify, Vercel/Next.js core, OpenAI's
browser platform team, Chrome, Netlify, and the creator of MCP-B — a technical,
security-literate audience. Depth and honesty in the security story will land.

## Eligibility notes

- Participants must be of legal age of majority; several countries/territories
  are excluded (see Rules tab). Register on Devpost before submitting.
- Test in both target environments before submission: ChatGPT in-app browser
  (supports WebMCP out of the box) and Chrome with the flag enabled.

## Submission checklist (mirror of docs/09)

- [ ] Registered for the challenge on Devpost
- [ ] Live URL up, seeded with demo data, reachable without setup
- [ ] Demo credentials added to the submission form
- [ ] Text description drafted, hitting all four required points
- [ ] Video recorded, < 3 min, audio, uploaded to YouTube as Public
- [ ] Repo public, MIT license detected in About section
- [ ] `document.modelContext.registerTool` visibly present in repo + README
- [ ] README has full run instructions verified from a clean clone
- [ ] Submitted before Sep 3, 1:00 PM PDT (don't cut it close; Devpost forms
      take time)
