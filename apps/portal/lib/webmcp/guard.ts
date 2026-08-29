import { createGuard, type Guard } from "@webmcp-guard/sdk";

import { readBrowserSessionContext } from "@/lib/session/browser";
import { SITE } from "@/lib/site";

/**
 * The portal's WebMCP Guard client — the browser half of the pipeline
 * (`docs/03-architecture.md`).
 *
 * One guard per page: `createGuard` owns the event stream the Agent Activity
 * drawer renders, so a second instance would split the history in two. The
 * singleton is module scoped (module scope *is* page scope in the browser)
 * rather than on `globalThis`, because nothing on the server ever touches it —
 * the server half lives in `lib/guard/server.ts`.
 */

/** Where `app/api/guard/[...route]/route.ts` mounts `@webmcp-guard/server`. */
export const GUARD_ENDPOINT = "/api/guard";

/** App identifier used for policy scoping (`match.apps`). */
export const GUARD_APP = SITE.id;

let guard: Guard | null = null;

export function getGuard(): Guard {
  guard ??= createGuard({
    endpoint: GUARD_ENDPOINT,
    app: GUARD_APP,
    /**
     * The host app's identity hook (`docs/04`). Read fresh on every tool call,
     * so switching persona in the header takes effect on the next call with no
     * re-registration.
     *
     * It is a *claim*: the page can say anything, and the guard server does not
     * take its word for it. `apps/portal/lib/guard/server.ts` re-derives the
     * session from the signed httpOnly cookie and that is what policy and the
     * audit log use — this value only ever gets to disagree, which the audit
     * entry then records.
     */
    getSessionContext: () => readBrowserSessionContext(),
  });
  return guard;
}

/** Test seam: drops the singleton so the next `getGuard()` builds a fresh one. */
export function resetGuard(): void {
  guard = null;
}
