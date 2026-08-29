/**
 * `@webmcp-guard/shared` — the single source of truth for the policy model, the
 * client/server wire contract, and the audit log shape. Both Next.js apps, the
 * browser SDK, and the Node server import their schemas from here.
 */
export const PACKAGE_NAME = "@webmcp-guard/shared" as const;

export * from "./data-class";
export * from "./policy";
export * from "./wire";
export * from "./log";
