import type { NextRouteContext, NextRouteHandler, NextRouteHandlers } from "@webmcp-guard/server";

import { getGuardServer } from "@/lib/guard/server";

/**
 * `/api/guard/*` — WebMCP Guard mounted inside the host application
 * (`docs/03-architecture.md`).
 *
 * Everything the SDK and the console talk to lives under this one catch-all:
 * `POST /gate`, `POST /transform` (the agent channel, unauthenticated by design
 * — they are reachable by exactly whoever can already reach the page) and
 * `GET|POST|PUT|DELETE /policies`, `GET /logs`, `GET /stats` (the console's API,
 * behind the `GUARD_ADMIN_TOKEN` bearer).
 *
 * The handlers resolve the server lazily so importing this module never opens
 * the database — Next collects route metadata at build time without running a
 * request.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handlers: NextRouteHandlers | undefined;

function guardHandlers(): NextRouteHandlers {
  handlers ??= getGuardServer().nextHandler();
  return handlers;
}

export const GET: NextRouteHandler = (request: Request, context?: NextRouteContext) =>
  guardHandlers().GET(request, context);

export const POST: NextRouteHandler = (request: Request, context?: NextRouteContext) =>
  guardHandlers().POST(request, context);

export const PUT: NextRouteHandler = (request: Request, context?: NextRouteContext) =>
  guardHandlers().PUT(request, context);

export const DELETE: NextRouteHandler = (request: Request, context?: NextRouteContext) =>
  guardHandlers().DELETE(request, context);

export const OPTIONS: NextRouteHandler = (request: Request, context?: NextRouteContext) =>
  guardHandlers().OPTIONS(request, context);
