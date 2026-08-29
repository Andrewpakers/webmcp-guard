import { type PortalToolContext, createPortalTools, toModelContextTool } from "./tools";

/**
 * Raw WebMCP registration for the Lakeside Medical portal.
 *
 * This is the Phase 1 "before" path: the seven tools go straight onto
 * `document.modelContext` with nothing in between. Phase 2 swaps the two
 * `registerTool` calls below for `@webmcp-guard/sdk`, which keeps the same
 * literal call inside the SDK.
 *
 * Two constraints shape this file:
 *
 *  1. The challenge requires a plainly visible `document.modelContext.registerTool(`
 *     in the repository, so the call is written out literally rather than routed
 *     through a resolved variable.
 *  2. docs/03 and docs/08 require feature detection across both surfaces
 *     (`document` first, then the older `navigator` one) and graceful
 *     degradation when neither exists — the portal must stay fully usable for
 *     humans in a browser with no WebMCP at all.
 */

/** Which WebMCP entry point (if any) this browser exposes. */
export type WebMcpSurface = "document" | "navigator" | "unavailable";

export interface RegisterResult {
  surface: WebMcpSurface;
  /** Names of the tools that actually registered, in order. */
  registered: string[];
}

export interface RegisterPortalToolsOptions {
  /**
   * Aborting this signal unregisters every tool registered by this call. React
   * StrictMode mounts effects twice in development, so the component owns one
   * controller per mount and aborts it on cleanup (docs/08).
   */
  signal: AbortSignal;
  context?: PortalToolContext;
}

/** Hint shown to a developer (and in the header chip) when WebMCP is missing. */
export const WEBMCP_ENABLE_HINT =
  "WebMCP not detected. Enable chrome://flags/#enable-webmcp-testing and relaunch Chrome, " +
  "or open this page in ChatGPT's in-app browser.";

let hasWarned = false;

/** Test seam: lets a test observe the once-only console warning more than once. */
export function resetWebMcpWarning(): void {
  hasWarned = false;
}

/** Returns the live model context for event wiring, or `null` when unsupported. */
export function resolveModelContext(): WebMCP.ModelContext | null {
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  return null;
}

/** Feature detection only — never registers anything. */
export function detectWebMcpSurface(): WebMcpSurface {
  if (typeof document !== "undefined" && document.modelContext) return "document";
  if (typeof navigator !== "undefined" && navigator.modelContext) return "navigator";
  return "unavailable";
}

/**
 * Registers all seven portal tools against whichever WebMCP surface is present.
 *
 * Returns `{ surface: "unavailable", registered: [] }` (after one console
 * warning) when there is no WebMCP — callers use that to render the gray status
 * chip rather than to fail.
 */
export async function registerPortalTools(
  options: RegisterPortalToolsOptions,
): Promise<RegisterResult> {
  const { signal } = options;
  const definitions = createPortalTools(options.context);
  const registered: string[] = [];

  if (typeof document !== "undefined" && document.modelContext) {
    for (const definition of definitions) {
      // The signal may already be aborted: StrictMode's first mount is torn down
      // immediately, and registering against a dead signal would leak a tool.
      if (signal.aborted) break;
      await document.modelContext.registerTool(toModelContextTool(definition), { signal });
      registered.push(definition.name);
    }
    return { surface: "document", registered };
  }

  if (typeof navigator !== "undefined" && navigator.modelContext) {
    for (const definition of definitions) {
      if (signal.aborted) break;
      await navigator.modelContext.registerTool(toModelContextTool(definition), { signal });
      registered.push(definition.name);
    }
    return { surface: "navigator", registered };
  }

  if (!hasWarned) {
    hasWarned = true;
    console.warn(`[Lakeside Medical] ${WEBMCP_ENABLE_HINT}`);
  }
  return { surface: "unavailable", registered: [] };
}

/** Live count of tools this document exposes, for the header status chip. */
export async function countRegisteredTools(): Promise<number> {
  const modelContext = resolveModelContext();
  if (!modelContext) return 0;
  try {
    const tools = await modelContext.getTools();
    return tools.length;
  } catch {
    return 0;
  }
}
