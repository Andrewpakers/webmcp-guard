/**
 * `@webmcp-guard/server` — the Node half of WebMCP Guard and the enforcement
 * point (`docs/03-architecture.md`).
 *
 * Owns policy resolution, the audit log writer, and the HTTP route handlers
 * mounted inside the host app (`/gate`, `/transform`, `/policies`, `/logs`,
 * `/stats`). The classification/tokenization pipeline and the token vault land
 * in Phase 3; the confirmation and justification flows in Phase 5.
 */
export const PACKAGE_NAME = "@webmcp-guard/server" as const;

export {
  createGuardServer,
  RESERVED_RULE_IDS,
  type GuardServer,
  type GuardServerConfig,
  type NextRouteContext,
  type NextRouteHandler,
  type NextRouteHandlers,
  type NextRouteParams,
} from "./server";

export {
  GATE_ACTION_TYPES,
  UNEVALUATABLE_MATCHERS,
  isEvaluableMatch,
  orderRules,
  resolvePolicy,
  ruleMatches,
  type PolicyDecision,
  type PolicyInput,
} from "./policy-engine";

export { DEFAULT_POLICY_RULES, seedDefaultPolicy } from "./seed";

export {
  confirmationMessage,
  defaultDenyMessage,
  denyMessage,
  justificationMessage,
  verdictMessage,
} from "./messages";

export { agentInfoFromPosture, pickBrand } from "./posture";

export { UNAUTHORIZED_MESSAGE, bearerToken, isAdminRequest, secretsMatch } from "./auth";

export { ERROR_CODES, type ErrorCode, type GuardErrorBody } from "./http";
