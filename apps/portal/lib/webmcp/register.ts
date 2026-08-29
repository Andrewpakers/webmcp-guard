import { type Guard, type WebMcpSurface, detectWebMcpSurface } from "@webmcp-guard/sdk";

import { getGuard } from "./guard";
import { type PortalToolContext, createPortalTools } from "./tools";

/**
 * Registration of the Lakeside Medical tools, **through WebMCP Guard**.
 *
 * Phase 2 replaced the raw `document.modelContext.registerTool` calls that used
 * to live here with `guard.registerTool`, which wraps each tool's `execute` in
 * the gate → execute → transform pipeline before handing it to the browser. The
 * literal WebMCP call the challenge requires now lives in one place for the
 * whole product: `packages/sdk/src/webmcp.ts`.
 *
 * What this module still owns is portal-specific and unchanged in spirit:
 * feature detection for the header chip, a live tool count, and the
 * one-controller-per-mount contract React StrictMode needs (docs/08).
 */

/** Which WebMCP entry point (if any) this browser exposes. Detected by the SDK. */
export type { WebMcpSurface };
export { detectWebMcpSurface };

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
  /** Injectable guard — the tests pass one, the browser uses the singleton. */
  guard?: Guard;
}

/** Hint shown to a developer (and in the header chip) when WebMCP is missing. */
export const WEBMCP_ENABLE_HINT =
  "WebMCP not detected. Enable chrome://flags/#enable-webmcp-testing and relaunch Chrome, " +
  "or open this page in ChatGPT's in-app browser.";

/** Returns the live model context for event wiring, or `null` when unsupported. */
export function resolveModelContext(): WebMCP.ModelContext | null {
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  return null;
}

/**
 * Registers all seven portal tools with the guard.
 *
 * Never throws and never blocks the page: `guard.registerTool` reports failure
 * by resolving with `registered: false` (no WebMCP, an already-aborted signal,
 * or a definition the browser rejected), so a browser without WebMCP simply
 * yields `{ surface: "unavailable", registered: [] }` and the gray status chip.
 */
export async function registerPortalTools(
  options: RegisterPortalToolsOptions,
): Promise<RegisterResult> {
  const { signal } = options;
  const guard = options.guard ?? getGuard();
  const registered: string[] = [];

  for (const definition of createPortalTools(options.context)) {
    // The signal may already be aborted: StrictMode's first mount is torn down
    // immediately, and registering against a dead signal would leak a tool.
    if (signal.aborted) break;
    const result = await guard.registerTool(definition, { signal });
    if (result.registered) registered.push(result.tool);
  }

  return { surface: guard.surface, registered };
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
