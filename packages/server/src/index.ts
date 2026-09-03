/**
 * `@webmcp-guard/server` — the Node half of WebMCP Guard and the enforcement
 * point (`docs/03-architecture.md`).
 *
 * Owns policy resolution, the classification/tokenization pipeline, the
 * encrypted token vault, the audit log writer, and the HTTP route handlers
 * mounted inside the host app (`/gate`, `/transform`, `/policies`,
 * `/policies/effective`, `/logs`, `/stats`, `/tokens/reveal`) — including the
 * Phase 5 posture, one-time-confirmation and justification flows.
 */
export const PACKAGE_NAME = "@webmcp-guard/server" as const;

export {
  createGuardServer,
  NAME_DICTIONARY_TTL_MS,
  RESERVED_RULE_IDS,
  type GuardServer,
  type GuardServerConfig,
  type NextRouteContext,
  type NextRouteHandler,
  type NextRouteHandlers,
  type NextRouteParams,
} from "./server";

export {
  buildNameMatcher,
  classesIn,
  classify,
  classifyKey,
  keyWords,
  orderClasses,
  passesLuhn,
  placeFrom,
  resolveOverlaps,
  scanText,
  singularize,
  DEFAULT_MRN_PATTERN,
  MAX_NAME_DICTIONARY,
  type Classification,
  type ClassifiedArray,
  type ClassifiedNode,
  type ClassifiedObject,
  type ClassifiedPrimitive,
  type ClassifiedString,
  type ClassifierOptions,
  type NameMatcher,
  type PlaceContext,
  type ScanOptions,
  type Span,
} from "./classify";

export {
  canonicalizeDate,
  canonicalizeValue,
  createTokenizer,
  type Tokenizer,
  type TokenizerOptions,
} from "./tokenize";

export {
  ageBracket,
  contextualize,
  maskValue,
  parseBirthDate,
  transformValue,
  MASK_GLYPH,
  type ContextualizeContext,
  type TransformOptions,
  type TransformOutcome,
} from "./transform";

export {
  collectGuardTokens,
  detokenize,
  substituteTokens,
  type DetokenizeResult,
  type TokenResolver,
} from "./detokenize";

export {
  GATE_ACTION_TYPES,
  UNEVALUATABLE_MATCHERS,
  agentMatcherMatches,
  agentMatches,
  isEvaluableMatch,
  orderRules,
  resolvePolicy,
  ruleMatches,
  type PolicyDecision,
  type PolicyInput,
} from "./policy-engine";

export { DEFAULT_POLICY_RULES, seedDefaultPolicy } from "./seed";

export {
  CONFIRMATION_TTL_MS,
  canonicalJson,
  hashCallArgs,
  validateConfirmation,
  type ConfirmationFailure,
} from "./confirmation";

export {
  DEFAULT_JUSTIFICATION_MIN_CHARS,
  FILLER_JUSTIFICATIONS,
  JUSTIFICATION_ARG,
  MAX_JUSTIFICATION_CHARS,
  heuristicJustificationEvaluator,
  isKeyboardMash,
  isSingleRepeatedCharacter,
  stripJustification,
  type JustificationEvaluation,
  type JustificationEvaluationInput,
  type JustificationEvaluator,
  type SyncJustificationEvaluator,
} from "./justification";

export {
  EVALUATOR_FALLBACK_NOTE,
  HUMAN_APPROVED_MESSAGE,
  confirmationMessage,
  confirmationRejectedMessage,
  defaultDenyMessage,
  denyMessage,
  humanApprovedNote,
  justificationAcceptedNote,
  justificationMessage,
  transformNotice,
  verdictMessage,
} from "./messages";

export { agentInfoFromPosture, pickBrand, postureBrands } from "./posture";

export { UNAUTHORIZED_MESSAGE, bearerToken, isAdminRequest, secretsMatch } from "./auth";

export { ERROR_CODES, type ErrorCode, type GuardErrorBody } from "./http";
