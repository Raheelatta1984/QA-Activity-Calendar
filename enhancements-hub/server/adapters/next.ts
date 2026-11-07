/**
 * Next.js App Router adapter.
 *
 * Mount the whole hub under any route prefix with ONE file:
 *
 *   app/hub/[[...path]]/route.ts
 *   ----------------------------------------------------------
 *   import { mountHub } from "enhancements-hub/adapters/next";
 *   const hub = mountHub({ basePath: "/hub" });
 *   export const GET = hub, POST = hub, PATCH = hub, DELETE = hub, OPTIONS = hub;
 *   ----------------------------------------------------------
 *
 * The hub is then live at /hub/api/v1/* and /hub/mcp. Bring your own identity
 * by passing an auth adapter that reads the host session instead of headers:
 *
 *   const hub = mountHub({
 *     basePath: "/hub",
 *     auth: {
 *       identify: async () => {
 *         const session = await getSession();          // your auth
 *         return { actor: session?.name ?? "anonymous", role: session ? "editor" : "viewer" };
 *       },
 *     },
 *   });
 */

import { createHubHandler, type HubOptions } from "../app.ts";

export function mountHub(options: HubOptions = {}) {
  const handle = createHubHandler(options);
  const handler = async (request: Request) => handle(request);
  return Object.assign(handler, {
    GET: handler,
    POST: handler,
    PATCH: handler,
    PUT: handler,
    DELETE: handler,
    OPTIONS: handler,
  });
}
