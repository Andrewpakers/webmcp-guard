"use client";

import type { PolicyDocument, Rule } from "@webmcp-guard/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useAuth, useGuardClient } from "@/components/auth-provider";
import { EmptyState, ErrorNote, Panel, StatusDot, Toggle } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/api/client";
import { isPostureRule } from "@/lib/policy/rule-form";
import {
  DATA_CLASS_REFERENCE,
  DETECTORS,
  STORAGE_NOTE,
  TOKEN_FORMAT,
  TRANSFORM_ACTION_HINT,
  TRANSFORM_ACTION_ORDER,
} from "@/lib/settings/reference";

/**
 * Settings (`docs/06-console-requirements.md` §4): a read-only account of what
 * this deployment detects and how it tokenizes, the posture rule pack toggle,
 * and "about this deployment".
 *
 * Everything except the rule toggles is deliberately static documentation — the
 * detectors live in `@webmcp-guard/server`, and a console that pretended to
 * configure them would be lying about where enforcement happens.
 */
export function SettingsView() {
  const client = useGuardClient();
  const { endpoint } = useAuth();

  const [policy, setPolicy] = useState<PolicyDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState<"ok" | "error" | "idle">("idle");
  const [appId, setAppId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (client === null) return;
    try {
      setPolicy(await client.getPolicy());
      setReachable("ok");
      setError(null);
    } catch (caught) {
      setReachable("error");
      setError(errorMessage(caught));
    }
    // The guard server has no "who am I" endpoint; the app id it guards shows
    // up on every log entry, so read it off the newest one. Absence just means
    // no agent has called a tool yet — not an error.
    try {
      const page = await client.queryLogs({ limit: 1 });
      setAppId(page.entries[0]?.app ?? null);
    } catch {
      setAppId(null);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleRule(rule: Rule, enabled: boolean) {
    if (client === null) return;
    setBusy(true);
    try {
      await client.updateRule(rule.id, { enabled });
      setPolicy(await client.getPolicy());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const postureRules = (policy?.rules ?? []).filter(isPostureRule);
  const evaluatorRules = (policy?.rules ?? []).filter(
    (rule) => rule.action.type === "require-justification" && rule.action.llmEvaluate === true,
  );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-100">Settings</h1>
        <p className="text-xs text-slate-400">
          What this deployment recognises, how it replaces it, and where it all lives.
        </p>
      </div>

      {error !== null && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel title="About this deployment">
        <dl className="grid gap-x-6 gap-y-3 px-4 py-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="gc-label">Guard API endpoint</dt>
            <dd className="mt-0.5 font-mono break-all text-slate-200">{endpoint}</dd>
          </div>
          <div>
            <dt className="gc-label">Guarded app id</dt>
            <dd className="mt-0.5 font-mono text-slate-200">
              {appId ?? "— (no agent activity logged yet)"}
            </dd>
          </div>
          <div>
            <dt className="gc-label">Connectivity</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 text-slate-200">
              <StatusDot state={reachable} />
              {reachable === "ok"
                ? "reachable — admin token accepted"
                : reachable === "error"
                  ? "unreachable or rejected"
                  : "checking…"}
            </dd>
          </div>
          <div>
            <dt className="gc-label">Console storage</dt>
            <dd className="mt-0.5 text-slate-300">None. {STORAGE_NOTE}</dd>
          </div>
          <div>
            <dt className="gc-label">Admin session</dt>
            <dd className="mt-0.5 text-slate-300">
              Bearer token in this tab&rsquo;s sessionStorage. One shared admin token — no user
              accounts, no RBAC (out of scope by design).
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Data classes"
        subtitle="The ten classes v1 recognises, in the order the transform matrix renders them."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th scope="col" className="gc-label px-4 py-2">
                  Class
                </th>
                <th scope="col" className="gc-label px-3 py-2">
                  Detected by
                </th>
                <th scope="col" className="gc-label px-3 py-2">
                  Example
                </th>
              </tr>
            </thead>
            <tbody>
              {DATA_CLASS_REFERENCE.map((entry) => (
                <tr key={entry.dataClass} className="border-b border-slate-900 last:border-0">
                  <td className="px-4 py-1.5 align-top">
                    <span className="font-mono text-slate-200">{entry.dataClass}</span>
                    <span className="ml-2 text-slate-500">{entry.label}</span>
                  </td>
                  <td className="px-3 py-1.5 align-top text-slate-400">{entry.description}</td>
                  <td className="px-3 py-1.5 align-top font-mono text-slate-500">
                    {entry.example}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Token format" subtitle="What an agent sees instead of the real value.">
          <div className="space-y-3 px-4 py-3 text-xs">
            <p className="font-mono text-sm text-cyan-300">{TOKEN_FORMAT.pattern}</p>
            <p className="font-mono text-slate-400">e.g. {TOKEN_FORMAT.example}</p>
            <ul className="list-disc space-y-1 pl-4 text-slate-400">
              {TOKEN_FORMAT.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </Panel>

        <Panel title="Detectors" subtitle="Classification runs server-side, on every result.">
          <ul className="divide-y divide-slate-900 text-xs">
            {DETECTORS.map((detector) => (
              <li key={detector.name} className="px-4 py-2.5">
                <p className="font-medium text-slate-200">{detector.name}</p>
                <p className="mt-0.5 text-slate-400">{detector.detail}</p>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-800 px-4 py-2.5 text-xs">
            <p className="gc-label mb-1">Transform actions</p>
            <ul className="space-y-1 text-slate-400">
              {TRANSFORM_ACTION_ORDER.map((action) => (
                <li key={action}>
                  <span className="font-mono text-slate-200">{action}</span> —{" "}
                  {TRANSFORM_ACTION_HINT[action]}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <Panel
        title="Posture rule pack"
        subtitle="Phase 5 — posture matchers are inert until the engine ships them, so these ship disabled."
      >
        {postureRules.length === 0 ? (
          <EmptyState title="No posture rules in this policy">
            The posture pack seeds rules whose id or name mentions “posture”. Add one in{" "}
            <Link href="/policies" className="gc-link">
              Policies
            </Link>
            , or wait for the Phase 5 seed.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-900">
            {postureRules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <Toggle
                  checked={rule.enabled}
                  disabled={busy}
                  onChange={(enabled) => void toggleRule(rule, enabled)}
                  label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                />
                <div className="min-w-0">
                  <p className="text-slate-200">{rule.name}</p>
                  <p className="font-mono text-[0.6875rem] text-slate-500">{rule.id}</p>
                </div>
                <Link href={`/policies#${rule.id}`} className="gc-btn ml-auto">
                  Open rule →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Justification evaluator"
        subtitle="Rules that ask the evaluator to judge a justification (Phase 5)."
      >
        {evaluatorRules.length === 0 ? (
          <EmptyState title="No rule requests LLM evaluation">
            Turn on “evaluate with the LLM evaluator” on a require-justification rule to use it.
            With no LLM_API_KEY configured the server falls back to the heuristic evaluator.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-900 text-xs">
            {evaluatorRules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="font-mono text-slate-300">{rule.id}</span>
                <span className="text-slate-500">{rule.name}</span>
                <Link href={`/policies#${rule.id}`} className="gc-btn ml-auto">
                  Open rule →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
