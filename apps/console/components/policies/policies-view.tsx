"use client";

import type { PolicyDocument } from "@webmcp-guard/shared";
import { useCallback, useEffect, useState } from "react";

import { useGuardClient } from "@/components/auth-provider";
import { RuleEditor } from "@/components/policies/rule-editor";
import { RuleRow } from "@/components/policies/rule-row";
import { EmptyState, ErrorNote, Panel, Spinner } from "@/components/ui/primitives";
import { errorMessage } from "@/lib/api/client";
import {
  emptyRuleForm,
  formToCreateBody,
  formToUpdateBody,
  moveRule,
  ruleToForm,
  type RuleFormState,
} from "@/lib/policy/rule-form";
import { LIVE_POLICY_NOTICE } from "@/lib/site";

/**
 * The policy editor (`docs/06-console-requirements.md` §2): the ordered rule
 * list with enable/disable and arrow re-prioritisation, the structured builder,
 * and the document-level default action.
 *
 * Every mutation re-reads `GET /policies` afterwards rather than patching local
 * state, so what is on screen is always what the engine will use on the next
 * tool call.
 */
export function PoliciesView() {
  const client = useGuardClient();

  const [policy, setPolicy] = useState<PolicyDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    try {
      setPolicy(await client.getPolicy());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // The audit log links here as /policies#<ruleId>; highlight and scroll to it
  // once the rules have actually rendered.
  useEffect(() => {
    if (policy === null) return;
    const id = window.location.hash.replace(/^#/, "");
    if (id.length === 0) return;
    setHighlighted(id);
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [policy]);

  /**
   * Runs a policy mutation, then re-reads the document so the list always shows
   * server truth (priorities in particular are re-numbered by the adapter).
   */
  async function mutate(
    action: (api: NonNullable<typeof client>) => Promise<unknown>,
    options: { editor?: boolean } = {},
  ) {
    const api = client;
    if (api === null) return false;

    setBusy(true);
    if (options.editor === true) setEditorError(null);
    else setError(null);

    try {
      await action(api);
      setPolicy(await api.getPolicy());
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      if (options.editor === true) setEditorError(message);
      else setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(form: RuleFormState) {
    const ok = await mutate((api) => api.createRule(formToCreateBody(form)), { editor: true });
    if (ok) setCreating(false);
  }

  async function onSave(id: string, form: RuleFormState) {
    const ok = await mutate((api) => api.updateRule(id, formToUpdateBody(form)), { editor: true });
    if (ok) setEditingId(null);
  }

  const rules = policy?.rules ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Policies</h1>
          <p className="text-xs text-slate-400">
            Ordered rules, lowest priority first. The first match per aspect wins — one gate verdict,
            one transform matrix.
          </p>
        </div>
        <button
          type="button"
          className="gc-btn gc-btn-primary"
          onClick={() => {
            setCreating(true);
            setEditingId(null);
            setEditorError(null);
          }}
          disabled={creating || client === null}
        >
          + Add rule
        </button>
      </div>

      <p className="rounded-md border border-indigo-900/60 bg-indigo-950/40 px-3 py-2 text-xs text-indigo-200">
        {LIVE_POLICY_NOTICE} The SDK re-reads policy per call, so a toggle here changes the very next
        thing the agent tries.
      </p>

      {error !== null && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel
        title="Default action"
        subtitle="Applied when no rule matches a call."
        actions={
          <div className="flex items-center gap-1">
            {(["allow", "deny"] as const).map((action) => (
              <button
                key={action}
                type="button"
                className={`gc-btn ${
                  policy?.defaultAction === action
                    ? action === "allow"
                      ? "border-emerald-500/60 bg-emerald-950/50 text-emerald-200"
                      : "border-red-500/60 bg-red-950/50 text-red-200"
                    : ""
                }`}
                disabled={busy || policy === null || policy.defaultAction === action}
                onClick={() => void mutate((api) => api.setDefaultAction(action))}
              >
                {action}
              </button>
            ))}
          </div>
        }
      >
        <p className="px-4 py-2.5 text-xs text-slate-400">
          {policy?.defaultAction === "deny"
            ? "Deny-by-default: any tool call no rule covers is refused. Safe, and noisy — every new tool needs a rule."
            : "Allow-and-log by default: unmatched calls run and are recorded. The demo stays permissive except where the story needs teeth."}
        </p>
      </Panel>

      {creating && (
        <Panel title="New rule">
          <RuleEditor
            mode="create"
            initial={emptyRuleForm()}
            busy={busy}
            error={editorError}
            onSubmit={(form) => void onCreate(form)}
            onCancel={() => {
              setCreating(false);
              setEditorError(null);
            }}
          />
        </Panel>
      )}

      {loading && policy === null ? (
        <Panel>
          <Spinner label="Loading policy" />
        </Panel>
      ) : rules.length === 0 ? (
        <Panel>
          <EmptyState title="No rules yet">
            Every call is decided by the default action until you add one. Start with a transform
            rule on your PHI-tagged tools.
          </EmptyState>
        </Panel>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={index}
              count={rules.length}
              busy={busy}
              highlighted={highlighted === rule.id}
              editing={editingId === rule.id}
              onMove={(direction) =>
                void mutate((api) =>
                  api.reorderRules(
                    moveRule(
                      rules.map((item) => item.id),
                      rule.id,
                      direction,
                    ),
                  ),
                )
              }
              onToggle={(enabled) => void mutate((api) => api.updateRule(rule.id, { enabled }))}
              onEdit={() => {
                setEditingId(editingId === rule.id ? null : rule.id);
                setCreating(false);
                setEditorError(null);
              }}
              onDelete={() => void mutate((api) => api.deleteRule(rule.id))}
            >
              {editingId === rule.id && (
                <RuleEditor
                  mode="edit"
                  initial={ruleToForm(rule)}
                  busy={busy}
                  error={editorError}
                  onSubmit={(form) => void onSave(rule.id, form)}
                  onCancel={() => {
                    setEditingId(null);
                    setEditorError(null);
                  }}
                />
              )}
            </RuleRow>
          ))}
        </ul>
      )}
    </div>
  );
}
