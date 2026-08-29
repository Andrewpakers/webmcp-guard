import type { NextConfig } from "next";

/**
 * The console has no database of its own — it only needs the shared schemas —
 * but it compiles the `@webmcp-guard/*` workspace packages from TypeScript
 * source the same way the portal does.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@webmcp-guard/shared"],
};

export default nextConfig;
