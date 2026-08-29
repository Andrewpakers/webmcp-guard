# Demo video script — WebMCP Guard

**Target: 2:55. Hard ceiling 3:00.** Public YouTube, audio required.
Record 1080p+ or better, one take per segment, tight cuts, no dead air.

Layout: portal (or ChatGPT's in-app browser) fills the frame; the console is a
full-screen cut-in, not a split. Two browser profiles side by side is fussy on
camera — cut instead.

Every quoted string below is the product's real output, captured from a running
build. If a take produces different words, **the script is wrong, not the
build** — re-capture and fix this file.

Before recording: wipe `apps/portal/data/` so the seed is fresh and the audit
log is empty; confirm the header chip is green; confirm all four enabled seed
rules are present in the console's Policies page and both `posture-*` rules are
**off**. Keep a backup take of every segment.

---

## 0:00 – 0:20 — The problem

**Shot.** Portal at `/patients` (60 patients listed), then cut to the raw
"before" capture on screen as plain text — `docs/captures/phase1-before/tool-export_patients-raw.txt`,
scrolled to the first data row so the SSN is legible. Highlight
`927-78-1337` for a beat.

**Voiceover (48 words):**

> WebMCP lets any website hand its tools to an AI agent. For anything with
> sensitive data, that's a non-starter. This is a fictitious hospital portal.
> Here's what an agent sees when you register those tools the normal way —
> names, dates of birth, social security numbers, straight into a language
> model's context.

**Recording notes.** Portal, `http://<portal>/patients`. Nothing to type. The
raw capture is a committed file — open it in a text editor or a browser tab, do
not re-run the unguarded build.

---

## 0:20 – 0:40 — What WebMCP Guard is

**Shot.** The integration diff, full screen, large type — the same diff as in
the SDK README. Then one beat on the pipeline diagram from the root README.

```diff
- await document.modelContext.registerTool({
+ await guard.registerTool({
    name: "search_patients",
    description: "...",
    inputSchema: { ... },
+   tags: ["read", "phi"],
    execute: async (input) => { ... },
  }, { signal });
```

**Voiceover (46 words):**

> WebMCP Guard is an SDK that wraps your WebMCP tools with policy, posture
> checks, data tokenization and audit — managed from a console. This is the
> whole integration: one line changed, one added. Every call now runs through a
> gate in your own backend before the tool executes.

**Recording notes.** Static slide or editor. Do not narrate over a build.

---

## 0:40 – 1:30 — The tokenization moment (hero segment)

**Shot.** Live agent conversation in ChatGPT's in-app browser (or Chrome 149+
with the flag), portal visible. Then cut into the portal UI to show the note
landing on the real patient.

**Prompt 1 to type:**

> Find patients with hypertension who have an appointment coming up, and tell me
> who the first one is.

Result arrives with `tok_name_…`, `tok_mrn_…`, and `dob` as an age bracket like
`age 60-69`. Conditions and appointment times are in the clear. Let the tokens
sit on screen for two seconds.

**Prompt 2 to type** (use the token the agent just showed you):

> Add a note to that patient: "Called about refill, patient will collect
> Thursday."

**Voiceover (95 words):**

> Now the same search, through the guard. The agent gets tokens instead of
> names and record numbers. Dates of birth come back as an age bracket,
> addresses as a city — but conditions and appointment times are untouched.
> This isn't redaction.
>
> Watch what happens when I ask it to write a note. The agent hands that same
> token back — and the server swaps the real value in before the tool runs. The
> note lands on the right patient.
>
> Tokens are deterministic. The same person is always the same token, so the
> agent can reason about identity — across tools, across turns, even inside the
> text of a clinical note. It just never sees the value.

**Recording notes.** Rehearse until the agent reliably passes the token back
rather than re-searching. After prompt 2, cut to that patient's detail page in
the portal and show the new note with the **real** name. Optionally open the
Agent Activity drawer (portal header, right side) for two seconds — it lists
`gate`, `executed`, `transformed` for each call.

---

## 1:30 – 2:05 — Teeth

**Shot A — justification.** Agent chat, then the portal.

**Prompt 3 to type:**

> Export all patients to CSV.

The agent is refused. Show the reply on screen; it is exactly this:

> Justification required by policy Export requires justification
> (`export-requires-justification`): call "export_patients" again with a
> "justification" argument of at least 40 characters explaining why this data is
> needed and for whom — name the person or team who asked, and what they will do
> with it.

The agent supplies one and retries; the export succeeds.

**Shot B — confirmation.** Same session.

**Prompt 4 to type** (use the token from earlier):

> Delete patient tok_mrn_… — they asked to be removed.

The in-page modal appears. It reads **"WebMCP Guard · approval required"**,
then **An agent wants to run “delete_patient”**, then the policy's own words:

> Human confirmation required by policy Destructive tools require human
> confirmation (`destructive-requires-confirmation`): Destructive actions on
> patient records have to be approved by the person using this page. The call
> was not executed — ask the person using this page to approve it.

Click **Decline**. The agent's reply:

> This call needed human approval and the person at the keyboard declined it, so
> nothing was done. … Do not try again unless they ask you to — tell them it was
> declined and ask what they would like instead.

**Voiceover (72 words):**

> Bulk export demands a written justification — the agent has to say who asked
> and what for. It supplies one, the evaluator accepts it, and the export runs,
> with that justification stored on the audit record.
>
> Deleting a patient asks a human. Not a checkbox buried in settings — a prompt,
> in the page, for the person actually sitting there. I decline. And the agent
> gets a clean explanation of the policy rather than a mysterious failure.

**Recording notes.** The modal's default focus is **Decline**, so a stray
keystroke can't approve. The approval is single-use and bound to those exact
arguments — worth one sentence if you have room, cut it if you don't.

---

## 2:05 – 2:40 — The console

**Shot.** Cut to the console, already logged in. `Logs` → open the newest entry
in the detail drawer → `Policies` → flip one cell in the transform matrix →
back to the agent for one search → 5 seconds on `Dashboard`.

**Voiceover (78 words):**

> Every one of those calls is here. Inputs, outputs, the rules that matched, the
> verdict — and the payload before and after transformation, side by side.
> Revealing a value in this drawer is itself written to the audit log.
>
> Policies are live. This is the transform matrix — per data class, per rule.
> I'll switch names from tokenize to mask, and run the same search again. Same
> deployment, no redeploy, next call.

**Recording notes.** Console `/login` first (admin token from the deployment's
`GUARD_ADMIN_TOKEN`) — cut the login itself. The rule to edit is
**"Tokenize PHI on phi-tagged tools"** (`phi-transform-default`); change the
`name` row from `tokenize` to `mask`. The SDK re-checks effective policy every
30 seconds, but a transform change takes effect on the very next call, so no
waiting. **Change it back before the next take.** If a role beat fits: the
header persona switcher → Sam Levin (billing) → `get_patient` returns note
bodies as `▪▪▪` under **"Billing sees no clinical notes"**.

---

## 2:40 – 3:00 — Close

**Shot.** Portal and console side by side, or the root README's pipeline
diagram. URL and repo link on screen for the full segment.

**Voiceover (55 words):**

> A generic SDK. Bring your own database. MIT licensed, with a threat model
> that says plainly what it does and does not defend against.
>
> Every company that wants agents in its internal apps has to build this, and
> almost none of them will build it well. This is the layer that lets regulated
> industries say yes to the agent-native web.

**Recording notes.** End on the URL card, held for three full seconds so a
judge can read it. No music sting over the last word.

---

## Totals and fallbacks

Voiceover ≈ 394 words ≈ 2:35 at a measured 150 wpm, leaving ~20 seconds of
breathing room inside the 3:00 ceiling. Trim from the close first, then from the
console segment. **Never trim the tokenization segment** — it is the entire
argument.

If the agent misbehaves on camera:

- **It re-searches instead of reusing the token.** Fine — say "and it can look
  the same person up *by the token*," which is also true and is the same point.
- **The export justification is rejected as filler.** Also fine, and better
  television: show the second attempt passing.
- **A tool call times out.** Cut, reload the page (registration is idempotent),
  retake. Do not narrate an error.
- **The header chip is grey.** WebMCP is not enabled. Relaunch Chrome with the
  flag actually applied, or switch to ChatGPT's in-app browser, before recording
  anything.
