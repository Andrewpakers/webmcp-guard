import type {
  DataClass,
  PerClassTransform,
  TransformAction,
  VaultEntry,
} from "@webmcp-guard/shared";

import {
  classify,
  keyWords,
  orderClasses,
  type ClassifiedNode,
  type ClassifiedString,
  type ClassifierOptions,
  type PlaceContext,
  type Span,
} from "./classify";
import type { Tokenizer } from "./tokenize";

/**
 * The outbound transform: a classified tool result plus the policy's per-class
 * matrix in, the copy the agent is allowed to see out
 * (`docs/04-sdk-requirements.md` → transform actions;
 * `docs/05-demo-app-requirements.md` → default policy 1).
 *
 * Four actions, applied per data class:
 *
 * | action | effect |
 * |---|---|
 * | `tokenize` | replace with `tok_<class>_<hex8>` and remember the original in the vault |
 * | `mask` | replace with a class-aware mask that keeps the last four digits where that is the norm |
 * | `contextualize` | replace with the *useful* residue: a DOB becomes an age bracket, an address becomes "City, ST" |
 * | `passthrough` | leave it alone |
 *
 * Three invariants a reviewer should hold this file to:
 *
 * 1. **Nothing is mutated.** Every container is rebuilt; the caller's `result`
 *    is still byte-identical afterwards, because `/transform` logs it as
 *    `payloads.resultBefore`.
 * 2. **No transform rule, no transformation.** A `null` matrix returns the
 *    input untouched — `docs/05` is explicit that the guard is not
 *    redaction-happy where the data is not sensitive.
 * 3. **Contextualize degrades to tokenize, never to plaintext.** A class with
 *    no contextualizer (or a value the contextualizer cannot parse) is
 *    tokenized instead of being passed through. Failing open here would turn a
 *    misconfigured policy into a data leak.
 * 4. **A span tokenizes its identity, not its text.** A dictionary hit that
 *    resolved to a fuller value (`Span.identity` — a bare "Tricia" standing for
 *    "Tricia Bashirian") is hashed as that value, so one person has one token
 *    however their name happens to be written in a note.
 */

/** Generic redaction glyph for classes with no digit-preserving convention. */
export const MASK_GLYPH = "▪▪▪";

const DOT = "•";

export interface TransformOptions {
  /** The matched rule's matrix, or `null` when no transform rule applied. */
  perClass: PerClassTransform | null;
  tokenizer: Tokenizer;
  /** Passed through to the classifier (MRN pattern, name dictionary). */
  classifier?: ClassifierOptions;
  /** Clock for the DOB age brackets. Injectable so tests do not drift. */
  now?: Date;
}

/**
 * The mechanisms reported in {@link TransformOutcome.actionsApplied}, in the
 * order the agent-facing notice explains them.
 */
const MECHANISMS = ["tokenize", "mask", "contextualize"] as const;

export interface TransformOutcome {
  /** The copy the agent receives. */
  result: unknown;
  /** Every class the classifier found, in `DATA_CLASSES` order. */
  classesFound: DataClass[];
  /**
   * Vault rows minted by `tokenize` actions, in first-seen order. The caller
   * persists them (`storage.putVaultEntry`, first-write-wins), which keeps this
   * whole module synchronous and pure.
   */
  vaultEntries: VaultEntry[];
  /**
   * The mechanisms that **actually replaced something**, in `MECHANISMS` order.
   * Empty means the agent is holding a byte-identical copy of what the tool
   * returned.
   *
   * "Actually" is literal: an action is only recorded when its output differs
   * from its input, so `contextualize` on a `city` field — which keeps the city
   * — does not count, and a matched-but-inert policy produces an empty list.
   * `/transform` uses this to decide whether the result needs a privacy notice
   * and which mechanisms that notice should explain; a passthrough result stays
   * clean, prose included.
   */
  actionsApplied: TransformAction[];
}

/** Classifies `value` and applies the matrix to it. */
export function transformValue(value: unknown, options: TransformOptions): TransformOutcome {
  const { root, classes } = classify(value, options.classifier ?? {});

  if (options.perClass === null) {
    // Classification still happened — the audit log records what was in the
    // payload even when policy chose to let it through untouched.
    return { result: value, classesFound: classes, vaultEntries: [], actionsApplied: [] };
  }

  const vaultEntries: VaultEntry[] = [];
  const seen = new Set<string>();
  const applied = new Set<TransformAction>();
  const context: ApplyContext = {
    perClass: options.perClass,
    tokenizer: options.tokenizer,
    now: options.now ?? new Date(),
    applied,
    emit(entry) {
      if (seen.has(entry.token)) return;
      seen.add(entry.token);
      vaultEntries.push(entry);
    },
  };

  const result = transformNode(root, context);

  return {
    result,
    classesFound: classes,
    vaultEntries,
    actionsApplied: MECHANISMS.filter((mechanism) => applied.has(mechanism)),
  };
}

interface ApplyContext {
  perClass: PerClassTransform;
  tokenizer: Tokenizer;
  now: Date;
  /** Mechanisms that have replaced at least one value so far. */
  applied: Set<TransformAction>;
  emit: (entry: VaultEntry) => void;
}

function transformNode(node: ClassifiedNode, context: ApplyContext): unknown {
  switch (node.kind) {
    case "primitive":
      return node.value;
    case "array":
      return node.items.map((item) => transformNode(item, context));
    case "object": {
      // A fresh object, in the original key order.
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) out[entry.key] = transformNode(entry.node, context);
      return out;
    }
    case "string":
      return transformString(node, context);
  }
}

function transformString(node: ClassifiedString, context: ApplyContext): unknown {
  if (node.fieldClass !== null) {
    const action = context.perClass[node.fieldClass];
    if (action === "passthrough") {
      // A number that a key claimed keeps its original JSON type when nothing
      // is done to it.
      return node.numeric ? Number(node.value) : node.value;
    }
    return applyAction(node.value, node.fieldClass, action, node, context);
  }

  if (node.spans.length === 0) return node.numeric ? Number(node.value) : node.value;

  /**
   * Free text with detector hits. Two distinct behaviours, and the distinction
   * matters enough to spell out:
   *
   * - When `free_text_phi` is anything other than `passthrough`, the policy is
   *   saying "do this to whole free-text fields" — the entire note is
   *   tokenized/masked as one value.
   * - Otherwise (the shipped default) each **span follows its own class's**
   *   action. A patient name inside a visit note is governed by the `name` row
   *   of the matrix, not by the `free_text_phi` row. `free_text_phi` is a
   *   *reporting* class for the console's filters; it is not the switch that
   *   turns span replacement on.
   */
  const freeAction = context.perClass.free_text_phi;
  if (freeAction !== "passthrough") {
    return applyAction(node.value, "free_text_phi", freeAction, node, context);
  }

  return replaceSpans(node, context);
}

/** Rebuilds a string with each span replaced according to its own class. */
function replaceSpans(node: ClassifiedString, context: ApplyContext): string {
  let out = "";
  let cursor = 0;

  for (const span of node.spans) {
    const action = context.perClass[span.dataClass];
    if (action === "passthrough") continue;

    out += node.value.slice(cursor, span.start);
    out += applyAction(span.text, span.dataClass, action, node, context, span);
    cursor = span.end;
  }

  out += node.value.slice(cursor);
  return out;
}

function applyAction(
  value: string,
  dataClass: DataClass,
  action: TransformAction,
  node: ClassifiedString,
  context: ApplyContext,
  span?: Span,
): string {
  /**
   * What this text *is*, as opposed to how it was written here. For a bare
   * dictionary hit that is the person's full name; for everything else it is
   * the text itself. Only tokenization uses it — masking and generalizing
   * describe the text on the page, but a token asserts an identity, and the
   * identity of "Tricia" in a note about Tricia Bashirian is Tricia Bashirian.
   */
  const identity = span?.identity ?? value;

  switch (action) {
    case "passthrough":
      return value;

    case "tokenize":
      return record(tokenize(identity, dataClass, context), value, "tokenize", context);

    case "mask":
      return record(maskValue(value, dataClass), value, "mask", context);

    case "contextualize": {
      const contextualized = contextualize(value, dataClass, {
        // A span inside free text has no key of its own; it borrows the
        // enclosing field's place context but not its key.
        key: span === undefined ? node.key : null,
        place: node.place,
        now: context.now,
      });
      // No contextualizer for this class, or the value did not parse: fall back
      // to tokenize rather than leaking the original. The *token* is what the
      // agent then sees, so that is the mechanism recorded, not the one the
      // policy asked for.
      return contextualized === null
        ? record(tokenize(identity, dataClass, context), value, "tokenize", context)
        : record(contextualized, value, "contextualize", context);
    }
  }
}

/**
 * Notes that `mechanism` replaced something, and hands the replacement back.
 *
 * The `!==` is the whole point: `contextualize` on a `city` field returns the
 * city, which changes nothing, and a result nothing changed must not be
 * announced to the agent as though it had been.
 */
function record(
  replacement: string,
  original: string,
  mechanism: TransformAction,
  context: ApplyContext,
): string {
  if (replacement !== original) context.applied.add(mechanism);
  return replacement;
}

function tokenize(value: string, dataClass: DataClass, context: ApplyContext): string {
  const { token, entry } = context.tokenizer.seal(value, dataClass);
  context.emit(entry);
  return token;
}

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------

function lastFour(value: string): string | null {
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Class-aware masking. The last four digits of an SSN, a phone number or a card
 * survive, because that is the convention every clinician and call-centre
 * script already uses to confirm identity — a mask nobody can act on just
 * makes the tool useless.
 */
export function maskValue(value: string, dataClass: DataClass): string {
  switch (dataClass) {
    case "ssn": {
      const tail = lastFour(value);
      return tail === null ? MASK_GLYPH : `${DOT.repeat(3)}-${DOT.repeat(2)}-${tail}`;
    }
    case "phone": {
      const tail = lastFour(value);
      return tail === null ? MASK_GLYPH : `(${DOT.repeat(3)}) ${DOT.repeat(3)}-${tail}`;
    }
    case "credit_card": {
      const tail = lastFour(value);
      return tail === null
        ? MASK_GLYPH
        : `${DOT.repeat(4)} ${DOT.repeat(4)} ${DOT.repeat(4)} ${tail}`;
    }
    case "email": {
      const at = value.lastIndexOf("@");
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      if (at <= 0 || domain.length === 0) return MASK_GLYPH;
      // One leading character keeps a human able to disambiguate two addresses
      // on the same domain without disclosing the mailbox.
      return `${local[0]}${DOT.repeat(3)}@${domain}`;
    }
    default:
      return MASK_GLYPH;
  }
}

// ---------------------------------------------------------------------------
// contextualize
// ---------------------------------------------------------------------------

export interface ContextualizeContext {
  /** The field key, when the value came from a structured field. */
  key: string | null;
  place: PlaceContext;
  now: Date;
}

/**
 * The alternative to redaction: keep what a clinician can reason with, drop
 * what identifies. `docs/03`: "DOB → age 40-49, address → city/state only".
 *
 * Returns `null` when this class has no contextualizer or the value cannot be
 * parsed — the caller then tokenizes instead.
 */
export function contextualize(
  value: string,
  dataClass: DataClass,
  context: ContextualizeContext,
): string | null {
  if (dataClass === "dob") return ageBracket(value, context.now);
  if (dataClass === "address") return contextualizeAddress(value, context);
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Parses the date shapes the classifier can produce. `null` if it is not one. */
export function parseBirthDate(value: string): { year: number; month: number; day: number } | null {
  const trimmed = value.trim();

  const iso = ISO_DATE.exec(trimmed);
  if (iso !== null) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  const us = US_DATE.exec(trimmed);
  if (us !== null) {
    return { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) };
  }

  return null;
}

/**
 * A date of birth as a decade bracket.
 *
 * The two ends are not decades on purpose: "age 90+" follows the HIPAA Safe
 * Harbor rule that ages over 89 are themselves identifying, and "under 10"
 * avoids a bracket that would single out infants in a small cohort.
 */
export function ageBracket(value: string, now: Date): string | null {
  const parsed = parseBirthDate(value);
  if (parsed === null) return null;

  const { year, month, day } = parsed;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let age = now.getUTCFullYear() - year;
  const monthNow = now.getUTCMonth() + 1;
  const dayNow = now.getUTCDate();
  if (monthNow < month || (monthNow === month && dayNow < day)) age -= 1;

  if (!Number.isFinite(age) || age < 0 || age > 130) return null;
  if (age < 10) return "under 10";
  if (age >= 90) return "age 90+";

  const decade = Math.floor(age / 10) * 10;
  return `age ${decade}-${decade + 9}`;
}

const ZIP_WORDS = new Set(["zip", "zipcode", "postal", "postcode"]);
const CITY_WORDS = new Set(["city", "town", "locality"]);
const STATE_WORDS = new Set(["state", "province", "region"]);

/** "123 Elm St, Portland, OR 97201" → city `Portland`, state `OR`. */
const CITY_STATE_IN_TEXT = /([A-Za-z][A-Za-z .'’-]{1,40}),\s*([A-Z]{2})\b/;

function contextualizeAddress(value: string, context: ContextualizeContext): string | null {
  const words = context.key === null ? [] : keyWords(context.key);

  // A ZIP keeps its first three digits: HIPAA Safe Harbor
  // §164.514(b)(2)(i)(B) treats the 3-digit prefix of a populous area as
  // de-identified, and a clinician can still see the rough catchment.
  if (words.some((word) => ZIP_WORDS.has(word))) {
    const digits = value.replace(/\D+/g, "");
    return digits.length >= 5 ? `${digits.slice(0, 3)}**` : MASK_GLYPH;
  }

  // City and state *are* the contextualized granularity — keep them as they are
  // rather than replacing "Portland" with "Portland, OR".
  if (words.some((word) => CITY_WORDS.has(word) || STATE_WORDS.has(word))) return value;

  const city = context.place.city;
  const state = context.place.state;
  if (city !== undefined && state !== undefined) return `${city}, ${state}`;
  if (city !== undefined) return city;
  if (state !== undefined) return state;

  const parsed = CITY_STATE_IN_TEXT.exec(value);
  if (parsed !== null) return `${parsed[1].trim()}, ${parsed[2]}`;

  // Nothing to keep. `null` means "tokenize this instead".
  return null;
}

/** Re-exported so callers can build the class list the same way the walk does. */
export { orderClasses };
