import type { Guard, GuardToolDefinition } from "./types";

/**
 * The React helper from `docs/04` — `useGuardTool(guard, definition, deps)`:
 * registers the tool on mount (and whenever `deps` change), unregisters on
 * unmount by aborting the registration signal. Shape mirrors the community
 * `usewebmcp` hook so it feels idiomatic.
 *
 * **Why a factory.** `@webmcp-guard/sdk` has no `react` dependency and must not
 * grow one: it is a browser SDK that has to work in plain JS, Svelte, or Vue
 * pages, and a duplicated React copy in a host's tree is a classic "invalid
 * hook call" source. So the host injects React's hooks once:
 *
 * ```tsx
 * import * as React from "react";
 * import { createUseGuardTool } from "@webmcp-guard/sdk/react";
 *
 * export const useGuardTool = createUseGuardTool(React);
 *
 * function PatientTools({ guard }) {
 *   useGuardTool(guard, searchPatientsTool, [guard]);
 *   return null;
 * }
 * ```
 *
 * The parameter is structurally typed, so it accepts the `react` namespace
 * import, `{ useEffect }`, or a test double — and this module imports nothing
 * from React at all, not even types.
 */

/** The one hook this helper needs. Structurally compatible with React's. */
export interface ReactHooks {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}

/** The hook `createUseGuardTool` returns. */
export type UseGuardTool = (
  guard: Guard,
  definition: GuardToolDefinition,
  deps?: readonly unknown[],
) => void;

/**
 * Binds the hook to a host's React instance.
 *
 * `deps` defaults to `[]` (register once per mount) rather than `undefined`,
 * which would re-register on every render. Registration failures never throw:
 * `guard.registerTool` resolves with `{ registered: false }` and reports the
 * reason through `guard.subscribe`.
 */
export function createUseGuardTool(react: ReactHooks): UseGuardTool {
  return function useGuardTool(guard, definition, deps = []) {
    react.useEffect(() => {
      const controller = new AbortController();
      // Fire and forget: React effects must return a cleanup function, not a
      // promise. Errors cannot escape `registerTool`, so there is nothing to
      // catch here.
      void guard.registerTool(definition, { signal: controller.signal });
      return () => {
        controller.abort();
      };
    }, deps);
  };
}
