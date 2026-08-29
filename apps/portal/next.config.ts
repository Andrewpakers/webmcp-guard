import type { NextConfig } from "next";

/**
 * The `@webmcp-guard/*` packages are consumed as TypeScript source inside the
 * workspace (no build step), so Next has to compile them like app code.
 */
const nextConfig: NextConfig = {
  transpilePackages: [
    "@webmcp-guard/sdk",
    "@webmcp-guard/server",
    "@webmcp-guard/shared",
    "@webmcp-guard/storage-memory",
    "@webmcp-guard/storage-sqlite",
  ],
};

export default nextConfig;
