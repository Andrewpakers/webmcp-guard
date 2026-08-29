import type { JsonObject, SessionContext } from "@webmcp-guard/shared";

/**
 * The justification evaluator (`docs/04-sdk-requirements.md` → "Justification
 * evaluator").
 *
 * A `require-justification` rule asks the agent to say, in words, why it needs
 * a bulk disclosure. Something then has to judge that answer, and the judging
 * is deliberately pluggable: this file ships the heuristic default, and a host
 * can pass its own `evaluator` (an LLM one, a queue that asks a supervisor, a
 * regex against a ticket number) to `createGuardServer`.
 *
 * **Scope, stated honestly.** The heuristic checks *effort*, not truth. It
 * cannot tell whether an export is genuinely needed — no automated check can —
 * so what it actually buys is: a deliberate act by the agent, a sentence the
 * person reviewing the audit log can read, and a speed bump in front of the
 * one-word "because I need it". That is the claim; nothing in this repo may
 * make a bigger one.
 */

/** Argument key the guard injects and then strips. Never reaches the tool. */
export const JUSTIFICATION_ARG = "justification";

/** Used when a `require-justification` rule does not name its own minimum. */
export const DEFAULT_JUSTIFICATION_MIN_CHARS = 40;

/** Longest justification kept, in the log and on the way to an evaluator. */
export const MAX_JUSTIFICATION_CHARS = 2000;

export interface JustificationEvaluationInput {
  /** Tool the justification is for, e.g. `"export_patients"`. */
  tool: string;
  /** The call's arguments **with `justification` already removed**. */
  args: JsonObject;
  /** What the agent wrote, trimmed and length-capped. */
  justification: string;
  context: {
    app: string;
    /** Minimum length the matched rule asks for. */
    minChars: number;
    /** Id of the rule that required a justification, when a rule did. */
    ruleId?: string;
    /** Host-supplied identity, when the app provided one. */
    session?: SessionContext;
  };
}

export interface JustificationEvaluation {
  verdict: "pass" | "fail";
  /** One short sentence. Ends up in the audit log and, on a fail, in the agent's message. */
  reason: string;
}

/**
 * Pluggable judge. Implementations may be async; they may not throw for
 * business reasons (return `{verdict: "fail"}` instead). A thrown error is
 * treated as evaluator *downtime*: the server falls back to the heuristic and
 * records the fallback, because `docs/04` is explicit that evaluator downtime
 * must never block the demo.
 */
export interface JustificationEvaluator {
  evaluate(
    input: JustificationEvaluationInput,
  ): JustificationEvaluation | Promise<JustificationEvaluation>;
}

/**
 * Low-effort answers, matched against the justification after it has been
 * lower-cased, stripped of punctuation and whitespace-collapsed.
 *
 * Short and hand-picked on purpose. This is a **demo heuristic**, not a
 * content-moderation product: the list exists so the video's "the agent tries
 * 'because I need it' and gets told what a real justification looks like" beat
 * works even if someone lowers `minChars`.
 */
export const FILLER_JUSTIFICATIONS: readonly string[] = [
  "because i need it",
  "i need it",
  "need it",
  "because",
  "just because",
  "no reason",
  "reasons",
  "test",
  "testing",
  "n a",
  "none",
  "idk",
  "asdf",
];

/** Rows of a QWERTY keyboard, for spotting mashed-out filler like "asdfasdf". */
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

/** Lower-cased, punctuation-free, single-spaced. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** True for `"aaaaaaa"`, `"...."`, `"- - - -"` — one character, repeated. */
export function isSingleRepeatedCharacter(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length > 0 && new Set(compact).size === 1;
}

/**
 * The shortest string that, repeated, produces `text` (`"asdfasdf"` → `"asdf"`,
 * `"aaaa"` → `"a"`, `"hello"` → `"hello"`). A partial final repeat counts, so
 * `"asdfasd"` also reduces to `"asdf"`.
 */
function repeatingUnit(text: string): string {
  for (let size = 1; size <= text.length; size += 1) {
    const unit = text.slice(0, size);
    const repeated = unit.repeat(Math.ceil(text.length / size)).slice(0, text.length);
    if (repeated === text) return unit;
  }
  return text;
}

/**
 * True for a run of adjacent keyboard characters, repeated or not
 * (`"asdf"`, `"asdfasdfasdf"`, `"qwertyuiop"`).
 *
 * Two steps: reduce the text to whatever unit it is repeating, then ask whether
 * that unit is a contiguous run along one keyboard row. Prose never survives
 * either step — its "unit" is the whole sentence, and no sentence is a
 * substring of `"asdfghjkl"` — so this has no false positives on anything long
 * enough to clear `minChars`.
 */
export function isKeyboardMash(text: string): boolean {
  const letters = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (letters.length < 4) return false;

  const unit = repeatingUnit(letters);
  return KEYBOARD_ROWS.some((row) => row.includes(unit));
}

/**
 * A judge that answers without awaiting anything. The heuristic is one, which
 * is what lets it double as the synchronous fallback when a pluggable
 * evaluator misbehaves.
 */
export interface SyncJustificationEvaluator extends JustificationEvaluator {
  evaluate(input: JustificationEvaluationInput): JustificationEvaluation;
}

/**
 * The default judge: long enough, and not obviously filler.
 *
 * Passing is the common case by design — a clinician's agent writing a real
 * sentence about a real patient should not have to fight the guard.
 */
export const heuristicJustificationEvaluator: SyncJustificationEvaluator = {
  evaluate({ justification, context }): JustificationEvaluation {
    const trimmed = justification.trim();
    const { minChars } = context;

    if (trimmed.length < minChars) {
      return {
        verdict: "fail",
        reason: `Too short: ${trimmed.length} characters, and this policy asks for at least ${minChars}.`,
      };
    }

    if (isSingleRepeatedCharacter(trimmed)) {
      return { verdict: "fail", reason: "The justification is one character repeated." };
    }

    if (isKeyboardMash(trimmed)) {
      return { verdict: "fail", reason: "The justification is keyboard filler, not a reason." };
    }

    if (FILLER_JUSTIFICATIONS.includes(normalize(trimmed))) {
      return {
        verdict: "fail",
        reason: "The justification is a stock phrase that does not say who needs the data or why.",
      };
    }

    return { verdict: "pass", reason: "Specific enough and long enough for this policy." };
  },
};

/**
 * Splits guard metadata out of the arguments the tool will run on.
 *
 * `justification` is an input to the *policy*, not to the tool: the portal's
 * schemas are `additionalProperties: false`, so leaving it in would make every
 * justified call fail validation inside the host app. The audit log keeps the
 * text (see `/gate`), so nothing is lost.
 */
export function stripJustification(args: JsonObject): {
  args: JsonObject;
  justification: string | null;
} {
  const raw = args[JUSTIFICATION_ARG];
  if (typeof raw !== "string") return { args, justification: null };

  const rest: JsonObject = { ...args };
  delete rest[JUSTIFICATION_ARG];
  return { args: rest, justification: raw.slice(0, MAX_JUSTIFICATION_CHARS) };
}
