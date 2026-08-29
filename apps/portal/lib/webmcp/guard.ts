import { createGuard, type Guard } from "@webmcp-guard/sdk";

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
  guard ??= createGuard({ endpoint: GUARD_ENDPOINT, app: GUARD_APP });
  return guard;
}

/** Test seam: drops the singleton so the next `getGuard()` builds a fresh one. */
export function resetGuard(): void {
  guard = null;
}
