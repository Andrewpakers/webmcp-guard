import { DATA_CLASSES, type DataClass } from "@webmcp-guard/shared";

/**
 * The classification engine (`docs/04-sdk-requirements.md` → "Classification
 * engine"). Three passes, in decreasing order of reliability:
 *
 * 1. **Field-name pass (primary).** Walk the JSON payload; a key like `ssn`,
 *    `dateOfBirth` or `insurance_member_id` classifies the *whole* value. This
 *    is why the portal's tools return structured objects rather than
 *    pre-formatted strings: real keys are the strongest signal there is.
 * 2. **Regex pass (secondary).** Scan string values that no key claimed — visit
 *    notes, summaries, CSV blobs — for SSNs, phones, e-mail, MRNs, credit cards
 *    (Luhn-checked) and dates in DOB-ish contexts.
 * 3. **Dictionary pass.** Names are the class regexes cannot do. The host app
 *    knows its own people, so it supplies them (`GuardServerConfig.nameDictionary`)
 *    and free text is scanned for "First Last" and "Ms. Last". `docs/04`
 *    explicitly sanctions this and files NER as future work.
 *
 * The output is an annotated *tree*, not a flat report, so `transform.ts` can
 * act on exactly what the classifier decided. Classifying and transforming
 * through one walk is deliberate: a second, separately-written walk would
 * eventually disagree with this one, and a security control that disagrees with
 * its own audit log is worse than no control.
 */

// ---------------------------------------------------------------------------
// Field-name pass
// ---------------------------------------------------------------------------

/**
 * Splits a key into lowercase words, handling both conventions a JSON API might
 * use: `firstName`, `first_name`, `FIRST-NAME` and `addressZIP` all yield the
 * same word list.
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/**
 * Keys that contain the word "name" but never a person's name. Without this,
 * `username` classifies as `name`, every login field in a payload gets
 * tokenized, and the product looks broken. `docs/04` calls out `username`
 * specifically.
 */
const NON_PERSON_NAME_KEYS = new Set([
  "username",
  "screenname",
  "displayname", // a UI label, not the person — see the note below
  "filename",
  "pathname",
  "hostname",
  "domainname",
  "classname",
  "fieldname",
  "tagname",
  "toolname",
  "typename",
  "brandname",
  "codename",
  "eventname",
  "appname",
]);

/**
 * `displayName` is arguable — in some schemas it *is* the person. It sits in
 * the deny list because in this product's payloads (tool names, rule names,
 * carrier names) it never is, and because a false negative here is recoverable
 * (the free-text/dictionary pass still catches a known patient's name) while a
 * false positive tokenizes UI chrome.
 */

interface FieldRule {
  dataClass: DataClass;
  matches: (words: string[], compact: string) => boolean;
}

/**
 * Naive de-pluralisation so `emails`, `phoneNumbers` and `addresses` classify
 * like their singular forms. Wrong on irregular English, which is fine: the
 * only cost of a miss is that the value falls through to the regex pass.
 */
export function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word) && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

const has = (words: string[], ...candidates: string[]): boolean =>
  words.some((word) => candidates.includes(word) || candidates.includes(singularize(word)));

/**
 * Evaluated in order; first match wins. The order resolves genuine ambiguity:
 * `emailAddress` is an e-mail, not an address; `insuranceMemberId` is an
 * insurance id, not an id; `cardholderName` is card data, not a bare name.
 */
const FIELD_RULES: FieldRule[] = [
  { dataClass: "ssn", matches: (w) => has(w, "ssn", "social") },
  {
    dataClass: "mrn",
    matches: (w, compact) =>
      has(w, "mrn") ||
      compact === "recordnumber" ||
      (has(w, "record") && has(w, "number")) ||
      (has(w, "medical") && has(w, "record")),
  },
  { dataClass: "dob", matches: (w) => has(w, "dob", "birth", "birthdate", "birthday") },
  { dataClass: "email", matches: (w) => has(w, "email", "mail") },
  { dataClass: "phone", matches: (w) => has(w, "phone", "mobile", "telephone", "cell") },
  // Every `insurance*` key is treated as an insurance identifier, including
  // `insuranceCarrier`. Over-classifying a carrier name is the conservative
  // direction for a security control, and docs/04 maps the bare word.
  { dataClass: "insurance_id", matches: (w) => has(w, "insurance") },
  { dataClass: "credit_card", matches: (w) => has(w, "credit", "card") },
  {
    dataClass: "name",
    matches: (w, compact) => has(w, "name") && !NON_PERSON_NAME_KEYS.has(compact),
  },
  {
    dataClass: "address",
    matches: (w) => has(w, "address", "street", "zip", "zipcode", "postal", "city", "state"),
  },
];

/** The class a key claims for its whole value, or `null`. */
export function classifyKey(key: string): DataClass | null {
  const words = keyWords(key);
  if (words.length === 0) return null;
  const compact = words.join("");

  for (const rule of FIELD_RULES) {
    if (rule.matches(words, compact)) return rule.dataClass;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Regex pass
// ---------------------------------------------------------------------------

/** One detector hit inside a string value. */
export interface Span {
  /** Index of the first character of the match. */
  start: number;
  /** Index one past the last character. */
  end: number;
  text: string;
  dataClass: DataClass;
  detector: string;
}

/** Default MRN shape: `LM-100042`. Overridable per deployment (`mrnPattern`). */
export const DEFAULT_MRN_PATTERN = /\b[A-Z]{2,4}-\d{5,8}\b/g;

const SSN_DELIMITED = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_BARE = /\b\d{9}\b/g;
const SSN_CONTEXT = /\b(?:ssn|ssns|social(?:\s+security)?)\b/i;

/**
 * US phone numbers as they are actually written: `(206) 555-0142`,
 * `206-555-0142`, `206.555.0142`, `+1 206-555-0142`. Deliberately conservative
 * — a bare run of ten digits is not treated as a phone number, because in a
 * clinical payload it is far more likely to be an account or claim number.
 */
const PHONE = /(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[.-])\d{3}[.-]\d{4}\b/g;

const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** 13–19 digits with optional space/dash separators. Luhn decides the rest. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

const ISO_DATE_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b/g;
const US_DATE_IN_TEXT = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;

/**
 * A date only means "date of birth" when something nearby says so. Without this
 * gate every appointment, every note header and every `createdAt` in the
 * payload would be reported as a DOB, the console would show `dob` on
 * everything, and the classifier would be untrustworthy.
 */
const DOB_CONTEXT = /\b(?:dob|d\.o\.b\.?|born|birth(?:day|date)?)\b/i;

/** Characters of context inspected on each side of a candidate date. */
const DOB_CONTEXT_BEFORE = 24;
const DOB_CONTEXT_AFTER = 16;

/** The Luhn check digit algorithm (ISO/IEC 7812-1). */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function matchAll(pattern: RegExp, text: string): RegExpExecArray[] {
  // A fresh regex per scan: a module-level /g regex carries `lastIndex` between
  // calls and would skip matches on the next string it saw.
  const scanner = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const hits: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    hits.push(match);
    // Zero-length matches would loop forever; a detector should never produce
    // one, but a caller-supplied `mrnPattern` might.
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  return hits;
}

function span(match: RegExpExecArray, dataClass: DataClass, detector: string): Span {
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    dataClass,
    detector,
  };
}

export interface ScanOptions {
  /** Overrides {@link DEFAULT_MRN_PATTERN}. */
  mrnPattern?: RegExp;
  /** Compiled known-person matcher from {@link buildNameMatcher}. */
  nameMatcher?: RegExp | null;
}

/**
 * Class precedence when two detectors claim overlapping text. Higher in the
 * list wins, so an SSN is never demoted to "part of a credit card number".
 */
const SPAN_PRIORITY: DataClass[] = ["ssn", "credit_card", "mrn", "phone", "email", "dob", "name"];

/** Finds every detector hit in a string, with overlaps resolved. */
export function scanText(text: string, options: ScanOptions = {}): Span[] {
  if (text.length === 0) return [];

  const candidates: Span[] = [];

  for (const match of matchAll(SSN_DELIMITED, text)) {
    candidates.push(span(match, "ssn", "ssn-delimited"));
  }

  // Nine bare digits are an SSN only when the surrounding prose says so.
  for (const match of matchAll(SSN_BARE, text)) {
    const before = text.slice(Math.max(0, match.index - DOB_CONTEXT_BEFORE), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (SSN_CONTEXT.test(before) || SSN_CONTEXT.test(after)) {
      candidates.push(span(match, "ssn", "ssn-bare-with-context"));
    }
  }

  for (const match of matchAll(PHONE, text)) candidates.push(span(match, "phone", "phone-us"));
  for (const match of matchAll(EMAIL, text)) candidates.push(span(match, "email", "email"));

  for (const match of matchAll(options.mrnPattern ?? DEFAULT_MRN_PATTERN, text)) {
    candidates.push(span(match, "mrn", "mrn-pattern"));
  }

  for (const match of matchAll(CARD_CANDIDATE, text)) {
    const digits = match[0].replace(/\D+/g, "");
    // A 13–19 digit run that fails Luhn is *not* a card number. Explicitly
    // tested: "1234-5678-9012-3456" must never be classified as one.
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      candidates.push(span(match, "credit_card", "credit-card-luhn"));
    }
  }

  for (const pattern of [ISO_DATE_IN_TEXT, US_DATE_IN_TEXT]) {
    for (const match of matchAll(pattern, text)) {
      const end = match.index + match[0].length;
      const before = text.slice(Math.max(0, match.index - DOB_CONTEXT_BEFORE), match.index);
      const after = text.slice(end, end + DOB_CONTEXT_AFTER);
      if (DOB_CONTEXT.test(before) || DOB_CONTEXT.test(after)) {
        candidates.push(span(match, "dob", "date-in-dob-context"));
      }
    }
  }

  if (options.nameMatcher) {
    for (const match of matchAll(options.nameMatcher, text)) {
      candidates.push(span(match, "name", "name-dictionary"));
    }
  }

  return resolveOverlaps(candidates);
}

/**
 * Greedy, priority-first overlap resolution: walk the candidates in class
 * precedence order (then longest first) and keep each one that does not collide
 * with something already kept. Returns them sorted by position, which is what
 * span replacement needs.
 */
export function resolveOverlaps(candidates: Span[]): Span[] {
  const ranked = [...candidates].sort((a, b) => {
    const priority = SPAN_PRIORITY.indexOf(a.dataClass) - SPAN_PRIORITY.indexOf(b.dataClass);
    if (priority !== 0) return priority;
    const length = b.end - b.start - (a.end - a.start);
    if (length !== 0) return length;
    return a.start - b.start;
  });

  const kept: Span[] = [];
  for (const candidate of ranked) {
    const collides = kept.some(
      (other) => candidate.start < other.end && other.start < candidate.end,
    );
    if (!collides) kept.push(candidate);
  }

  return kept.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Dictionary pass
// ---------------------------------------------------------------------------

/** Honorifics matched in front of a known last name. */
const HONORIFICS = ["mr", "mrs", "ms", "miss", "mx", "dr", "prof"];

/**
 * Upper bound on dictionary size. A regex alternation over an unbounded,
 * host-supplied list is a denial-of-service surface; 5000 names is far more
 * than any demo needs and keeps the compiled pattern sane.
 */
export const MAX_NAME_DICTIONARY = 5000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a list of known full names into one case-insensitive matcher for
 * "First Last" and "Ms. Last".
 *
 * Only *full* names go in verbatim; bare surnames are matched only behind an
 * honorific, because a lone "Park" or "Green" in clinical prose is usually not
 * a person. Returns `null` for an empty dictionary so callers can skip the pass
 * entirely.
 */
export function buildNameMatcher(names: readonly string[]): RegExp | null {
  const fullNames = new Set<string>();
  const lastNames = new Set<string>();

  for (const raw of names.slice(0, MAX_NAME_DICTIONARY)) {
    if (typeof raw !== "string") continue;
    const parts = raw
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0);
    if (parts.length < 2) continue;

    fullNames.add(parts.map(escapeRegExp).join("\\s+"));
    const last = parts[parts.length - 1];
    if (last.length >= 2) lastNames.add(escapeRegExp(last));
  }

  if (fullNames.size === 0) return null;

  const honorific = `(?:${HONORIFICS.join("|")})\\.?\\s+`;
  const alternatives = [
    // Longest first so "Tricia Bashirian" wins over a bare "Ms. Bashirian"
    // pattern that could otherwise claim part of the same text.
    ...[...fullNames].sort((a, b) => b.length - a.length),
    ...(lastNames.size > 0 ? [`${honorific}(?:${[...lastNames].join("|")})`] : []),
  ];

  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "gi");
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** City/state gathered from an object's own keys, for the address contextualizer. */
export interface PlaceContext {
  city?: string;
  state?: string;
}

export interface ClassifiedString {
  kind: "string";
  value: string;
  /** The key this value sat under, or `null` at the root / inside a bare array. */
  key: string | null;
  /** Set when the field name claimed the whole value. */
  fieldClass: DataClass | null;
  /** Detector hits. Only populated when `fieldClass` is `null`. */
  spans: Span[];
  /** City/state siblings visible from here. */
  place: PlaceContext;
  /** True when the source JSON value was a number, not a string. */
  numeric: boolean;
}

export interface ClassifiedObject {
  kind: "object";
  entries: { key: string; node: ClassifiedNode }[];
}

export interface ClassifiedArray {
  kind: "array";
  items: ClassifiedNode[];
}

export interface ClassifiedPrimitive {
  kind: "primitive";
  value: unknown;
}

export type ClassifiedNode =
  ClassifiedString | ClassifiedObject | ClassifiedArray | ClassifiedPrimitive;

export interface ClassifierOptions {
  /** Overrides {@link DEFAULT_MRN_PATTERN}. */
  mrnPattern?: RegExp;
  /** Known person names for the free-text dictionary pass. */
  names?: readonly string[];
  /** Pre-compiled matcher, when the caller is scanning many payloads. */
  nameMatcher?: RegExp | null;
}

export interface Classification {
  root: ClassifiedNode;
  /** Every class found anywhere, in `DATA_CLASSES` order. */
  classes: DataClass[];
}

const PLACE_CITY = new Set(["city", "town", "locality"]);
const PLACE_STATE = new Set(["state", "province", "region"]);

/** Reads city/state out of an object's own keys, for `contextualize` on address. */
export function placeFrom(value: Record<string, unknown>, inherited: PlaceContext): PlaceContext {
  const place: PlaceContext = { ...inherited };
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    const words = keyWords(key);
    if (words.some((word) => PLACE_CITY.has(word))) place.city = entry.trim();
    else if (words.some((word) => PLACE_STATE.has(word))) place.state = entry.trim();
  }
  return place;
}

/** Sorts a set of classes into the stable `DATA_CLASSES` order. */
export function orderClasses(found: Iterable<DataClass>): DataClass[] {
  const present = new Set(found);
  return DATA_CLASSES.filter((dataClass) => present.has(dataClass));
}

/**
 * Walks any JSON value and annotates it.
 *
 * Arrays hand their key down to their items, so `phones: ["206-555-0142"]`
 * classifies every element as a phone. Numbers are only pulled in when a key
 * claimed them (`zip: 97201`); an unclaimed number is never scanned, because
 * "digits that happen to pass Luhn" is not evidence of a credit card.
 */
export function classify(value: unknown, options: ClassifierOptions = {}): Classification {
  const nameMatcher =
    options.nameMatcher !== undefined
      ? options.nameMatcher
      : options.names && options.names.length > 0
        ? buildNameMatcher(options.names)
        : null;

  const scanOptions: ScanOptions = {
    ...(options.mrnPattern !== undefined ? { mrnPattern: options.mrnPattern } : {}),
    nameMatcher,
  };

  const found = new Set<DataClass>();

  function walkString(
    text: string,
    key: string | null,
    place: PlaceContext,
    numeric: boolean,
  ): ClassifiedString {
    const fieldClass = key === null ? null : classifyKey(key);

    if (fieldClass !== null) {
      found.add(fieldClass);
      // A key-claimed value is that class in its entirety. Re-scanning it for
      // sub-spans would let a `name` field be partly tokenized and partly not.
      return { kind: "string", value: text, key, fieldClass, spans: [], place, numeric };
    }

    const spans = scanText(text, scanOptions);
    if (spans.length > 0) {
      // Any string with detector hits is free-text PHI *as well as* whatever
      // its spans are: the console needs to be able to filter for "a note that
      // leaked something" independently of what leaked.
      found.add("free_text_phi");
      for (const hit of spans) found.add(hit.dataClass);
    }

    return { kind: "string", value: text, key, fieldClass: null, spans, place, numeric };
  }

  function walk(value: unknown, key: string | null, place: PlaceContext): ClassifiedNode {
    if (typeof value === "string") return walkString(value, key, place, false);

    if (typeof value === "number" && Number.isFinite(value) && key !== null) {
      // Only numbers a key claimed become strings; everything else stays a
      // number so `limit: 25` survives the round trip as a number.
      if (classifyKey(key) !== null) return walkString(String(value), key, place, true);
      return { kind: "primitive", value };
    }

    if (Array.isArray(value)) {
      return { kind: "array", items: value.map((item) => walk(item, key, place)) };
    }

    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const childPlace = placeFrom(record, place);
      return {
        kind: "object",
        entries: Object.entries(record).map(([childKey, childValue]) => ({
          key: childKey,
          node: walk(childValue, childKey, childPlace),
        })),
      };
    }

    return { kind: "primitive", value };
  }

  const root = walk(value, null, {});
  return { root, classes: orderClasses(found) };
}

/** Convenience wrapper for callers that only want the classes. */
export function classesIn(value: unknown, options: ClassifierOptions = {}): DataClass[] {
  return classify(value, options).classes;
}
