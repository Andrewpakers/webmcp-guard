"use client";

import { DATA_CLASSES, type DataClass } from "@webmcp-guard/shared";
import { useState } from "react";

import { TransformMatrix } from "@/components/policies/transform-matrix";
import { ChipInput } from "@/components/ui/chip-input";
import { Toggle } from "@/components/ui/primitives";
import {
  ACTION_HINT,
  ACTION_LABEL,
  ACTION_TYPES,
  formToRule,
  parseRuleJson,
  ruleToForm,
  ruleToJson,
  type RuleFormState,
  type ToolMatcherKind,
} from "@/lib/policy/rule-form";

/**
 * The structured rule builder (`docs/06-console-requirements.md` §2): WHEN on
 * the left, THEN on the right, and a raw-JSON escape hatch validated with the
 * shared `RuleSchema` before it can be applied.
 *
 * The component holds nothing but form state — every conversion and every
 * validation decision is a tested function in `lib/policy/rule-form`.
 */
export function RuleEditor({
  initial,
  mode,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: RuleFormState;
  mode: "create" | "edit";
  busy: boolean;
  error: string | null;
  onSubmit: (form: RuleFormState) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<RuleFormState>(initial);
  const [tab, setTab] = useState<"builder" | "json">("builder");
  const [jsonText, setJsonText] = useState("");
  const [issues, setIssues] = useState<string[]>([]);

  function patch(next: Partial<RuleFormState>) {
    setForm({ ...form, ...next });
  }

  function openJson() {
    const validated = formToRule(form);
    setJsonText(
      validated.ok
        ? ruleToJson(validated.rule)
        : JSON.stringify(
            {
              id: form.id.length > 0 ? form.id : "<generated from the name>",
              name: form.name,
              enabled: form.enabled,
              priority: form.priority ?? 0,
              match: {},
              action: { type: form.actionType },
            },
            null,
            2,
          ),
    );
    setIssues(validated.ok ? [] : validated.errors);
    setTab("json");
  }

  function applyJson() {
    const parsed = parseRuleJson(jsonText);
    if (!parsed.ok) {
      setIssues(parsed.errors);
      return;
    }
    setForm(ruleToForm(parsed.rule));
    setIssues([]);
    setTab("builder");
  }

  function submit() {
    const validated = formToRule(form);
    if (!validated.ok) {
      setIssues(validated.errors);
      return;
    }
    setIssues([]);
    onSubmit(form);
  }

  function toggleDataClass(dataClass: DataClass) {
    const next = form.dataClasses.includes(dataClass)
      ? form.dataClasses.filter((item) => item !== dataClass)
      : [...form.dataClasses, dataClass];
    patch({ dataClasses: next });
  }

  return (
    <div className="border-t border-slate-800 bg-slate-950/40 px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">
          {mode === "create" ? "New rule" : `Edit ${form.name}`}
        </h3>
        <div className="flex items-center gap-1">
          <TabButton active={tab === "builder"} onClick={() => setTab("builder")}>
            Builder
          </TabButton>
          <TabButton active={tab === "json"} onClick={openJson}>
            JSON
          </TabButton>
        </div>
      </div>

      {tab === "json" ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            The escape hatch. Validated against the shared{" "}
            <span className="font-mono">RuleSchema</span> — the same zod schema the server enforces —
            before it replaces the builder&rsquo;s state.
          </p>
          <textarea
            aria-label="Rule JSON"
            spellCheck={false}
            className="gc-input h-72 resize-y font-mono text-[0.6875rem] leading-relaxed"
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="gc-btn gc-btn-primary" onClick={applyJson}>
              Validate &amp; load into builder
            </button>
            <button type="button" className="gc-btn" onClick={() => setTab("builder")}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="space-y-3">
            <SectionTitle>When</SectionTitle>

            <Labelled label="Rule name">
              <input
                className="gc-input"
                placeholder="Tokenize PHI in tool results"
                value={form.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Labelled>

            {mode === "create" && (
              <Labelled label="Rule id" hint="Optional — the server derives one from the name.">
                <input
                  className="gc-input font-mono"
                  placeholder="tokenize-phi"
                  value={form.id}
                  onChange={(event) => patch({ id: event.target.value })}
                />
              </Labelled>
            )}

            <Labelled label="Apps" hint="Empty means every app that reports to this deployment.">
              <ChipInput
                label="Apps"
                placeholder="lakeside-portal"
                values={form.apps}
                onChange={(apps) => patch({ apps })}
              />
            </Labelled>

            <Labelled label="Tools">
              <div className="mb-1.5 flex flex-wrap gap-3 text-xs text-slate-400">
                {(["any", "names", "tags"] as ToolMatcherKind[]).map((kind) => (
                  <label key={kind} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="toolKind"
                      className="accent-indigo-500"
                      checked={form.toolKind === kind}
                      onChange={() => patch({ toolKind: kind })}
                    />
                    {kind === "any" ? "any tool" : kind === "names" ? "by name" : "by tag"}
                  </label>
                ))}
              </div>
              {form.toolKind === "names" && (
                <ChipInput
                  label="Tool names"
                  placeholder="delete_patient"
                  values={form.toolNames}
                  onChange={(toolNames) => patch({ toolNames })}
                />
              )}
              {form.toolKind === "tags" && (
                <ChipInput
                  label="Tool tags"
                  placeholder="phi, destructive"
                  values={form.toolTags}
                  onChange={(toolTags) => patch({ toolTags })}
                />
              )}
            </Labelled>

            <Labelled label="Roles" hint="Session roles supplied by the host app (Phase 6).">
              <ChipInput
                label="Roles"
                placeholder="clinician, billing"
                values={form.roles}
                onChange={(roles) => patch({ roles })}
              />
            </Labelled>

            <Labelled label="Data classes" hint="Matches when the payload contains these classes.">
              <div className="flex flex-wrap gap-1.5">
                {DATA_CLASSES.map((dataClass) => {
                  const active = form.dataClasses.includes(dataClass);
                  return (
                    <button
                      key={dataClass}
                      type="button"
                      onClick={() => toggleDataClass(dataClass)}
                      className={`gc-chip cursor-pointer ${
                        active ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200" : ""
                      }`}
                    >
                      {dataClass}
                    </button>
                  );
                })}
              </div>
            </Labelled>

            <Labelled
              label="Agent matchers"
              hint="Read-only: posture matchers land in Phase 5, and the engine treats them as inert until then."
            >
              <pre className="gc-json max-h-32">
                {form.agents === null ? "— none —" : JSON.stringify(form.agents, null, 2)}
              </pre>
            </Labelled>
          </section>

          <section className="space-y-3">
            <SectionTitle>Then</SectionTitle>

            <Labelled label="Action">
              <select
                className="gc-input"
                value={form.actionType}
                onChange={(event) =>
                  patch({ actionType: event.target.value as RuleFormState["actionType"] })
                }
              >
                {ACTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ACTION_LABEL[type]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[0.6875rem] text-slate-500">{ACTION_HINT[form.actionType]}</p>
            </Labelled>

            {form.actionType === "deny" && (
              <Labelled label="Denial message" hint="Returned to the agent verbatim.">
                <textarea
                  className="gc-input h-20 resize-y"
                  placeholder="Deleting a patient record is not available to agents. Ask the clinician to do it in the portal."
                  value={form.denyMessage}
                  onChange={(event) => patch({ denyMessage: event.target.value })}
                />
              </Labelled>
            )}

            {form.actionType === "require-confirmation" && (
              <Labelled label="Confirmation prompt" hint="Shown to the human in the page's modal.">
                <textarea
                  className="gc-input h-20 resize-y"
                  placeholder="Approve adding this note to the patient's chart?"
                  value={form.confirmationMessage}
                  onChange={(event) => patch({ confirmationMessage: event.target.value })}
                />
              </Labelled>
            )}

            {form.actionType === "require-justification" && (
              <div className="space-y-3">
                <Labelled label="Minimum characters" hint="Blank means no length requirement.">
                  <input
                    className="gc-input w-32"
                    inputMode="numeric"
                    placeholder="40"
                    value={form.minChars}
                    onChange={(event) => patch({ minChars: event.target.value })}
                  />
                </Labelled>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <Toggle
                    checked={form.llmEvaluate}
                    onChange={(llmEvaluate) => patch({ llmEvaluate })}
                    label="Evaluate the justification with the configured evaluator"
                  />
                  Evaluate with the LLM evaluator when one is configured
                </label>
              </div>
            )}

            {form.actionType === "transform" && (
              <Labelled
                label="Per-class transform matrix"
                hint="What the agent receives for each class of data found in the result."
              >
                <TransformMatrix
                  value={form.perClass}
                  onChange={(perClass) => patch({ perClass })}
                />
              </Labelled>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-300">
              <Toggle
                checked={form.enabled}
                onChange={(enabled) => patch({ enabled })}
                label="Rule enabled"
              />
              Enabled
            </label>
          </section>
        </div>
      )}

      {(issues.length > 0 || error !== null) && (
        <ul className="mt-3 space-y-1 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {error !== null && <li>{error}</li>}
          {issues.map((issue) => (
            <li key={issue} className="font-mono text-[0.6875rem]">
              {issue}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <button type="button" className="gc-btn gc-btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create rule" : "Save changes"}
        </button>
        <button type="button" className="gc-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="border-b border-slate-800 pb-1 text-[0.6875rem] font-semibold tracking-widest text-indigo-300 uppercase">
      {children}
    </h4>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="gc-label mb-1">{label}</p>
      {children}
      {hint !== undefined && <p className="mt-1 text-[0.6875rem] text-slate-500">{hint}</p>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`gc-btn ${active ? "border-indigo-500 bg-indigo-950/60 text-indigo-200" : ""}`}
    >
      {children}
    </button>
  );
}
