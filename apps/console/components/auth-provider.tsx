"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { errorMessage, type GuardApiError } from "@/lib/api/client";
import { createGuardClient, type GuardClient } from "@/lib/api/guard-client";
import {
  browserTokenStore,
  clearStoredToken,
  readStoredToken,
  storeToken,
} from "@/lib/auth/session";
import { guardApiUrl } from "@/lib/site";

/**
 * The console's whole notion of "being logged in": an admin bearer token held
 * in `sessionStorage` for this tab (`docs/06-console-requirements.md`).
 *
 * There is no server session and no cookie — every page is client-rendered and
 * talks to the portal's guard API directly, so this provider is the only thing
 * between the token and the network. A 401 from any call drops the token and
 * bounces to `/login` with an explanation.
 */

export type AuthStatus = "loading" | "connected" | "disconnected";

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  endpoint: string;
  /** Why the operator is back at /login, when they did not choose to be. */
  notice: string | null;
  /** Validates the token against `GET /stats` before storing it. */
  connect(token: string): Promise<{ ok: boolean; error?: string }>;
  disconnect(notice?: string): void;
  clearNotice(): void;
  /** `null` until connected. */
  client: GuardClient | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const endpoint = guardApiUrl();

  const [status, setStatus] = useState<AuthStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Restore the tab's token on first paint. Nothing is validated here: the
  // first real request does that, and a stale token lands on the 401 path.
  useEffect(() => {
    const stored = readStoredToken(browserTokenStore());
    setToken(stored);
    setStatus(stored === null ? "disconnected" : "connected");
  }, []);

  const disconnect = useCallback(
    (message?: string) => {
      clearStoredToken(browserTokenStore());
      setToken(null);
      setStatus("disconnected");
      setNotice(message ?? null);
      router.replace("/login");
    },
    [router],
  );

  // Held in a ref so the memoised client never has to be rebuilt when
  // `disconnect` changes identity — a new client mid-render would restart every
  // in-flight poll.
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  const client = useMemo(() => {
    if (token === null) return null;
    return createGuardClient({
      baseUrl: endpoint,
      token,
      onUnauthorized: (error: GuardApiError) => {
        disconnectRef.current(
          `${error.message} The admin token was cleared — reconnect to continue.`,
        );
      },
    });
  }, [endpoint, token]);

  const connect = useCallback(
    async (candidate: string) => {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) return { ok: false, error: "Enter the admin token." };

      // `GET /stats` is the cheapest admin-gated route: a 200 proves the token,
      // the endpoint URL and CORS all line up before anything is stored.
      const probe = createGuardClient({ baseUrl: endpoint, token: trimmed });
      try {
        await probe.getStats();
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }

      storeToken(browserTokenStore(), trimmed);
      setToken(trimmed);
      setStatus("connected");
      setNotice(null);
      return { ok: true };
    },
    [endpoint],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      token,
      endpoint,
      notice,
      connect,
      disconnect,
      clearNotice: () => setNotice(null),
      client,
    }),
    [status, token, endpoint, notice, connect, disconnect, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}

/**
 * The client for a page that has already passed the shell's auth guard.
 * Returns `null` for the one frame between a disconnect and the redirect.
 */
export function useGuardClient(): GuardClient | null {
  return useAuth().client;
}
