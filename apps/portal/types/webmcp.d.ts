/// <reference types="webmcp-types" />

/**
 * The published `webmcp-types` package declares `Document.modelContext` (the
 * current Chrome surface) but not `Navigator.modelContext` (the surface the
 * original explainer shipped, still present in some builds). docs/03 and docs/08
 * both require the portal to feature-detect *both*, so the legacy one is
 * declared here on top of the package's types.
 *
 * Keep this file as thin as possible — everything else should come from the npm
 * package so the project tracks the spec as it changes.
 */
declare global {
  interface Navigator {
    /** Legacy WebMCP entry point. Undefined in browsers that never shipped it. */
    readonly modelContext?: WebMCP.ModelContext;
  }
}

export {};
