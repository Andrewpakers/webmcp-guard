# 05 — Demo App Requirements: "Lakeside Medical" Patient Portal

A convincing but entirely fictitious internal EHR-lite. It must look like
software a hospital would actually run — that credibility carries the
"Potential Impact" judging criterion. Next.js App Router, Tailwind, SQLite via
the portal's own tables (patient data is the *host app's* database; WebMCP Guard's
tables live alongside it through the storage adapter).

## Look and feel

- Clean clinical SaaS aesthetic: sidebar nav, dense data tables, calm
  blue/slate palette, a fictional logo. No lorem ipsum anywhere.
- Persistent footer/banner: "Demo environment — all patient records are
  synthetic." (Also protects us with judges: nobody wonders if it's real PHI.)
- A small **WebMCP status chip** in the header: number of registered tools,
  green when WebMCP Guard is active, gray when WebMCP is unavailable (with the
  enable-flag hint). This makes the invisible layer visible in the video.
- An **"Agent Activity" drawer** in the portal showing live WebMCP Guard events
  for the current session (tool called → transformed → returned). This is the
  single most demo-friendly UI element in the project; do not skip it.

## Seed data (generated, committed as a deterministic generator not a dump)

- ~60 patients via faker with a fixed seed: full name, MRN (`LM-######`), DOB,
  SSN, phone, email, address, insurance carrier + member id, primary
  condition(s), medications, allergy flags.
- 2–6 visit notes per patient: dated free-text paragraphs that *embed* PHI
  (names, phone numbers, DOBs) so the free-text scanner has something real to
  catch.
- A handful of upcoming appointments per patient.
- Idempotent seed-on-boot: create schema + data if missing (see deployment
  decision in `03-architecture.md`).

## Human UI (keep it thin but complete)

- Patient list: searchable, sortable table.
- Patient detail: demographics, insurance, meds, notes timeline, appointments;
  edit demographics; add a visit note.
- Export page: CSV export of the current search result.
- Delete patient (with human confirm dialog) — exists so the agent-side
  "destructive action" story has a real counterpart.
- **Stretch (anti-circumvention demo, see threat model in `03-architecture.md`):
  masked-at-rest fields.** SSN/DOB/phone render masked in the DOM with a
  per-field click-to-reveal; each reveal is logged through the guard API as a
  human access event. Payoff line for the video: "even if an agent scrapes this
  page instead of calling the tools, the DOM only contains tokens." Build only
  after the Phase 4 checkpoint is deployed.
- Mock login (Phase 6): pick a user — Dr. Reyes (physician), Nurse Okafor
  (nursing), Sam Levin (billing) — sets a signed session cookie with the role.
  Until Phase 6, run as a single implicit admin session.

## WebMCP tools (registered through WebMCP Guard)

| Tool | Tags | Notes |
|---|---|---|
| `search_patients` | `read`, `phi` | Query by name/MRN/condition; returns summaries. The headline tokenization demo: names/MRNs come back as tokens, condition/appointment info in the clear. |
| `get_patient` | `read`, `phi` | Accepts MRN **or a WebMCP Guard token** (detokenization showcase). Full record, transformed per policy. |
| `update_patient` | `write`, `phi` | Update demographics/contact fields; accepts tokens in args. |
| `add_visit_note` | `write`, `phi` | Append a note; note text is scanned on the way *in* too (log what the agent wrote). |
| `list_appointments` | `read` | Upcoming appointments; mostly clear-text — shows WebMCP Guard isn't redaction-happy when data isn't sensitive. |
| `export_patients` | `read`, `phi`, `bulk`, `destructive-adjacent` | Returns CSV text; default policy: `require-justification`. |
| `delete_patient` | `write`, `destructive` | Default policy: `require-confirmation` (human modal) + justification. The video's dramatic beat. |

Tool descriptions must be written for agents: state what the tool does, what
tokens are, and that tokens can be passed back into other tools. Set
`annotations.readOnlyHint` correctly per tool.

## Default shipped policies (seeded, editable in console)

1. Transform rule: on tools tagged `phi`, tokenize `ssn`/`mrn`/`name`/
   `insurance_id`, contextualize `dob` (age bracket) and `address`
   (city/state), mask nothing, passthrough the rest.
2. `export_patients` → require-justification (min 40 chars, LLM evaluate when
   configured).
3. Tag `destructive` → require-confirmation + justification.
4. Agent posture: deny when browser major version < (current stable − 2) or
   agent unidentified — ship this rule **disabled** by default so judges'
   environments aren't blocked, and toggle it on live in the video to show
   posture enforcement.
5. Everything else: allow + log.

## Scripted demo path (build toward exactly this; details in docs/09)

1. Ask the agent: "Find patients with hypertension and tell me who has an
   appointment this week." → works; names arrive as tokens; agent reasons over
   them correctly.
2. "Add a note to that first patient: 'Called about refill.'" → agent passes
   the token back; detokenization does its thing; note appears in the UI.
3. "Export all patients to CSV." → blocked pending justification; agent
   supplies one; export proceeds; log shows it.
4. "Delete patient tok_name_x." → confirmation modal; human declines; agent
   receives a clean policy explanation.
5. Flip to console: audit trail of all of the above, then edit a policy and
   show the behavior change without redeploying.
