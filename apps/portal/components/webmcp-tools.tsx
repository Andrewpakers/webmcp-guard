"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import {
  type WebMcpSurface,
  countRegisteredTools,
  registerPortalTools,
  resolveModelContext,
} from "@/lib/webmcp/register";
import { PORTAL_DATA_CHANGED_EVENT, setWebMcpStatus } from "@/lib/webmcp/status";

/**
 * Mounts the portal's seven tools — through WebMCP Guard — for the lifetime of
 * the app shell.
 *
 * Renders nothing. Lives in the root layout so the tools are available on every
 * page, and every call an agent makes to them runs gate → execute → transform
 * against `/api/guard` before a result reaches the model.
 *
 * The AbortController is per mount: React StrictMode runs mount → cleanup →
 * mount in development, and `controller.abort()` in the cleanup unregisters the
 * first mount's tools so the second mount does not double-register (docs/08).
 */
export function WebMcpTools() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function syncToolCount(surface: WebMcpSurface): Promise<void> {
      const toolCount = await countRegisteredTools();
      if (!signal.aborted) setWebMcpStatus({ surface, toolCount, resolved: true });
    }

    void (async () => {
      const result = await registerPortalTools({
        signal,
        context: {
          onMutation: () => {
            // The human is watching this page while the agent works: re-render
            // the server components so the change shows up without a reload.
            routerRef.current.refresh();
            window.dispatchEvent(new CustomEvent(PORTAL_DATA_CHANGED_EVENT));
          },
        },
      });

      if (signal.aborted) return;

      setWebMcpStatus({
        surface: result.surface,
        toolCount: result.registered.length,
        resolved: true,
      });

      if (result.surface === "unavailable") return;

      // Keep the header chip honest if anything else registers or unregisters.
      const modelContext = resolveModelContext();
      modelContext?.addEventListener("toolchange", () => void syncToolCount(result.surface), {
        signal,
      });
    })();

    return () => controller.abort();
  }, []);

  return null;
}
