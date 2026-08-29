import type { NextConfig } from "next";

/**
 * The `@webmcp-guard/*` packages are consumed as TypeScript source inside the
 * workspace (no build step), so Next has to compile them like app code.
 *
 * `better-sqlite3` is a native Node addon: it must stay external to the server
 * bundle (webpack cannot pack a `.node` binary) and must never be pulled into a
 * client bundle. The data layer under `lib/db/` is only ever imported from
 * server components and route handlers, which keeps that true.
 */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@webmcp-guard/sdk",
    "@webmcp-guard/server",
    "@webmcp-guard/shared",
    "@webmcp-guard/storage-memory",
    "@webmcp-guard/storage-sqlite",
  ],
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
