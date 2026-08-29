# 08 — WebMCP Reference (as of late Aug 2026)

Condensed from the Chrome developer docs (developer.chrome.com/docs/ai/webmcp)
and the WebMCP explainer (github.com/webmachinelearning/webmcp). WebMCP is a
proposed standard under active change — if anything here disagrees with
observed browser behavior, trust the browser and note the discrepancy in the
work log.

## Availability

- Chrome 149+ behind `chrome://flags/#enable-webmcp-testing` (relaunch
  required); also available as an origin trial from Chrome 149 (registering the
  deployed origin for the trial removes the judges'-flag dependency in Chrome —
  worth doing in Phase 7 if quick, but judges are instructed how to enable the
  flag, so it's optional).
- ChatGPT's in-app browser supports WebMCP out of the box (primary judging
  environment).
- Only in origin-isolated documents; disabled if `document.domain` is set via
  `Origin-Agent-Cluster: ?0`. Gated by the `tools` Permissions Policy
  (default `self`; cross-origin iframes need `allow="tools"`). None of this
  requires action for a normal same-origin Next.js app.
- Feature detection: prefer `document.modelContext`; older explainer surface
  was `navigator.modelContext` — check both.
- TypeScript typings: `webmcp-types` on npm. React hook: `usewebmcp`.

## Imperative API — the parts WebMCP Guard uses

### Register

```js
await document.modelContext.registerTool({
  name: "toggle_layer",
  description: "…written for the agent…",
  inputSchema: {              // JSON Schema
    type: "object",
    properties: { layer: { type: "string", enum: [...] } },
    required: ["layer"],
  },
  execute: async (input, { signal }) => {
    // runs in the page; return a string (or MCP-style content) for the agent
    return "Done: …";
  },
  annotations: {
    readOnlyHint: false,          // set true for pure reads
    untrustedContentHint: true,   // result may contain user-generated content
  },
}, {
  signal: controller.signal,      // optional: abort() unregisters the tool
  // exposedTo: ["https://other-origin.example"]  // cross-origin exposure (unused here)
});
```

- `execute` receives `(input, { signal })`; honor the AbortSignal in
  long-running work (Chrome 153+: unregistering no longer cancels in-flight
  executions).
- Since WebMCP Guard rewrites schemas (justification injection), re-registration
  on policy change = abort old registration, register the new definition.

### Discover / execute / events (used for debug tooling, not core flow)

```js
const tools = await document.modelContext.getTools();       // same-origin by default
const result = await document.modelContext.executeTool(tool, '{"text":"hi"}');
document.modelContext.addEventListener("toolchange", () => { /* list changed */ });
```

`getTools()` returns registered tool metadata (name, description, inputSchema,
annotations, origin). Useful for the portal's status chip and for a dev-mode
"tools registered" panel.

## Declarative API

HTML form annotations that auto-create tools. Not used by WebMCP Guard (we need
the imperative pipeline), but worth one line in the README as related work.

## Testing workflow

1. Chrome + flag; hard-relaunch after enabling.
2. **Model Context Tool Inspector** extension (Chrome Web Store): lists
   registered tools live, manual tool invocation with schema validation, and a
   prompt-driven agent (Gemini-backed) for realistic end-to-end tests.
3. ChatGPT in-app browser for final validation — open the deployed URL inside
   ChatGPT and drive the demo script conversationally.
4. Reference demos for calibration: GoogleChromeLabs/webmcp-tools on GitHub
   (pizza-maker, react-flightsearch, page-agent).

## Design guidance that matters for this project

- Tool descriptions are prompt engineering: say what the tool does, what
  WebMCP Guard tokens are, and that tokens are valid inputs elsewhere. Reduce
  agent guesswork; enums over free strings where possible.
- Tools execute visibly in the page — lean into that: the human watching the
  portal *sees* the note appear, which is part of WebMCP's trust story and our
  demo's.
- Return strings the model can use; on WebMCP Guard denials, the error text is
  the UX ("Blocked by policy P-3: … provide a justification to proceed").
