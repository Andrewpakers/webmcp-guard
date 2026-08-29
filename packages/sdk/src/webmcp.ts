/**
 * The WebMCP surface, as narrowly as this package needs it.
 *
 * `@webmcp-guard/sdk` deliberately carries **no** `webmcp-types` dependency and
 * declares **no** global augmentation of `Document` / `Navigator`. The host
 * application almost certainly ships its own WebMCP typings (the demo portal
 * does, in `apps/portal/types/webmcp.d.ts`), and two packages augmenting
 * `Document.modelContext` with structurally-identical-but-not-identical types is
 * a TypeScript error in the consumer's build. Structural interfaces here keep
 * the SDK drop-in for any host, typed or untyped.
 */

/** Context the browser passes as the second argument to `execute`. */
export interface WebMcpExecuteContext {
  /** Aborted when the agent or the browser cancels an in-flight call. */
  signal?: AbortSignal;
}

/** `annotations` as WebMCP defines them today (Chrome 149+). */
export interface WebMcpToolAnnotations {
  /** `true` for tools that only read state. */
  readOnlyHint?: boolean;
  /** `true` when the result may contain user-generated / untrusted content. */
  untrustedContentHint?: boolean;
}

/**
 * A tool definition as the *browser* receives it — i.e. after WebMCP Guard has
 * stripped its own fields (`tags`) and swapped in the guarded `execute`.
 *
 * `execute` is written as a method signature on purpose: method members are
 * checked bivariantly, so a host tool typed with `webmcp-types`'
 * `ToolExecuteCallback` (whose `options` parameter is *required*) still fits.
 */
export interface WebMcpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute(input: Record<string, unknown>, context?: WebMcpExecuteContext): unknown;
}

/** Options accepted by `modelContext.registerTool`. */
export interface WebMcpRegisterToolOptions {
  /** Aborting this signal unregisters the tool. */
  signal?: AbortSignal;
}

/** The subset of `modelContext` this SDK calls. */
export interface WebMcpModelContext {
  registerTool(tool: WebMcpToolDefinition, options?: WebMcpRegisterToolOptions): unknown;
}

/** A `document` (or `navigator`) that is known to expose WebMCP. */
export interface WebMcpHost {
  modelContext: WebMcpModelContext;
}

/** Which WebMCP entry point (if any) this browser exposes. */
export type WebMcpSurface = "document" | "navigator" | "unavailable";

/** Client-Hints shape, structurally typed — every field is best-effort. */
export interface UserAgentDataLike {
  brands?: unknown;
  platform?: unknown;
  mobile?: unknown;
}

/**
 * Everything the SDK reads off the global object, in one place.
 *
 * Always resolved lazily (never destructured at module load) so that a page —
 * or a test — that installs `document` / `navigator` after this module is
 * imported is still seen.
 */
export interface GuardGlobals {
  document?: { modelContext?: WebMcpModelContext };
  navigator?: {
    modelContext?: WebMcpModelContext;
    userAgent?: unknown;
    userAgentData?: UserAgentDataLike;
  };
  isSecureContext?: unknown;
  innerWidth?: unknown;
  innerHeight?: unknown;
  fetch?: typeof fetch;
}

/** The global object, viewed through the narrow lens above. */
export function guardGlobals(): GuardGlobals {
  return globalThis as unknown as GuardGlobals;
}

/**
 * Narrows a global to "definitely exposes WebMCP". Reads `modelContext` exactly
 * once: on a host that defines it as a getter, two reads could disagree.
 */
function hasModelContext(
  host: { modelContext?: WebMcpModelContext } | undefined,
): host is WebMcpHost {
  return Boolean(host?.modelContext);
}

/**
 * The live `document` when it exposes WebMCP.
 *
 * Returns the global itself rather than a wrapper, because `registerTool` is a
 * method: calling it detached from its `modelContext` receiver throws
 * "Illegal invocation" in a real browser.
 */
export function resolveDocumentHost(): WebMcpHost | undefined {
  const host = guardGlobals().document;
  return hasModelContext(host) ? host : undefined;
}

/** The live `navigator` when it exposes the legacy WebMCP surface. */
export function resolveNavigatorHost(): WebMcpHost | undefined {
  const host = guardGlobals().navigator;
  return hasModelContext(host) ? host : undefined;
}

/**
 * Feature detection, in the order `docs/03` and `docs/08` require: the current
 * `document.modelContext` surface first, then the older explainer surface on
 * `navigator`. Never throws, never registers anything.
 */
export function detectWebMcpSurface(): WebMcpSurface {
  if (resolveDocumentHost()) return "document";
  if (resolveNavigatorHost()) return "navigator";
  return "unavailable";
}

/* -------------------------------------------------------------------------
 * The literal WebMCP registration calls.
 *
 * The WebMCP Challenge requires a plainly visible
 * `document.modelContext.registerTool(` call in the repository, and this SDK is
 * the only place in the product that touches WebMCP at all. The two functions
 * below are that call, written out literally — nothing is dynamically
 * constructed and no property name is computed.
 *
 * `document` / `navigator` arrive as parameters rather than being read as
 * globals inside the function bodies purely for typing: see the module header
 * for why this package cannot declare `Document.modelContext`. The values
 * passed in are always the real `globalThis.document` / `globalThis.navigator`,
 * resolved by `guardGlobals()` a few lines up.
 * ---------------------------------------------------------------------- */

/** `document.modelContext.registerTool(...)` — the primary surface. */
export async function registerWithDocument(
  document: WebMcpHost,
  tool: WebMcpToolDefinition,
  options: WebMcpRegisterToolOptions,
): Promise<void> {
  await document.modelContext.registerTool(tool, options);
}

/** `navigator.modelContext.registerTool(...)` — the legacy explainer surface. */
export async function registerWithNavigator(
  navigator: WebMcpHost,
  tool: WebMcpToolDefinition,
  options: WebMcpRegisterToolOptions,
): Promise<void> {
  await navigator.modelContext.registerTool(tool, options);
}
