/**
 * Where the admin token lives: **`sessionStorage` only**
 * (`docs/06-console-requirements.md` — "held in memory / sessionStorage").
 *
 * Never a cookie (nothing in this app is server-rendered against a session, and
 * a cookie would ride along on cross-origin requests we deliberately do not
 * make with credentials) and never `localStorage` (the token would outlive the
 * browser tab). Closing the tab logs the operator out, which is the behaviour a
 * shared-screen demo wants.
 */
export const TOKEN_STORAGE_KEY = "webmcp-guard-console.admin-token";

/** The slice of the `Storage` interface this module needs — trivially fakeable. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `sessionStorage`, or `null` during SSR / when storage is blocked. */
export function browserTokenStore(): TokenStore | null {
  try {
    if (typeof globalThis.sessionStorage === "undefined") return null;
    return globalThis.sessionStorage;
  } catch {
    // Some privacy modes throw on the property access itself.
    return null;
  }
}

export function readStoredToken(store: TokenStore | null): string | null {
  if (store === null) return null;
  try {
    const value = store.getItem(TOKEN_STORAGE_KEY);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}

export function storeToken(store: TokenStore | null, token: string): void {
  if (store === null) return;
  try {
    store.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // A console that cannot persist the token still works for this tab.
  }
}

export function clearStoredToken(store: TokenStore | null): void {
  if (store === null) return;
  try {
    store.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to do — the in-memory token is dropped by the caller regardless.
  }
}

/** `dev-only-admin-token…` → `dev-only…loy` for the header chip. */
export function maskToken(token: string): string {
  if (token.length <= 10) return "•".repeat(token.length);
  return `${token.slice(0, 4)}…${token.slice(-3)}`;
}

/**
 * Auto-login links: `/login?token=<admin token>`.
 *
 * The demo deployment's token is deliberately public (synthetic data only),
 * so a shareable link that signs the viewer straight in is a fair trade. The
 * caller must still scrub the parameter from the address bar before using the
 * token — links get copied, and the cleaned URL is what should be re-shared.
 */
export function readTokenParam(search: string): { token: string | null; cleanedSearch: string } {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { token: null, cleanedSearch: search };
  }
  const raw = params.get("token");
  const token = raw === null || raw.trim().length === 0 ? null : raw.trim();
  params.delete("token");
  const rest = params.toString();
  return { token, cleanedSearch: rest.length === 0 ? "" : `?${rest}` };
}
