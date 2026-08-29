"use client";

import { useSyncExternalStore } from "react";

import { WEBMCP_ENABLE_HINT } from "@/lib/webmcp/register";
import {
  getServerWebMcpStatus,
  getWebMcpStatus,
  guardedToolsTooltip,
  subscribeWebMcpStatus,
} from "@/lib/webmcp/status";

/**
 * Header chip that makes the invisible agent layer visible (docs/05).
 *
 * Green with a tool count once the tools are registered *through WebMCP Guard*,
 * gray with the enable-flag hint when the browser has no WebMCP at all. It reads
 * a plain external store rather than context because `<WebMcpTools />` lives in
 * a different subtree.
 */
export function WebMcpStatusChip() {
  const status = useSyncExternalStore(
    subscribeWebMcpStatus,
    getWebMcpStatus,
    getServerWebMcpStatus,
  );

  if (!status.resolved) {
    return (
      <Chip tone="idle" title="Looking for a WebMCP model context in this browser.">
        WebMCP: checking…
      </Chip>
    );
  }

  if (status.surface === "unavailable") {
    return (
      <Chip tone="off" title={WEBMCP_ENABLE_HINT}>
        WebMCP unavailable
      </Chip>
    );
  }

  return (
    <Chip tone="on" title={guardedToolsTooltip(status)}>
      Guarded: {status.toolCount} {status.toolCount === 1 ? "tool" : "tools"}
    </Chip>
  );
}

const TONES = {
  on: "border-emerald-300 bg-emerald-50 text-emerald-800",
  off: "border-slate-300 bg-slate-100 text-slate-600",
  idle: "border-slate-200 bg-slate-50 text-slate-500",
} as const;

const DOTS = {
  on: "bg-emerald-500",
  off: "bg-slate-400",
  idle: "bg-slate-300",
} as const;

function Chip({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONES[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]}`} aria-hidden />
      {children}
    </span>
  );
}
