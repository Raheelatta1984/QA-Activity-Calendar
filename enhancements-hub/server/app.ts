/**
 * createHubHandler — the one function every host embeds.
 *
 * Returns a standard Web-API handler `(Request) → Promise<Response>` that serves
 * the REST API and the MCP endpoint. Nothing here knows about Node's http
 * server, Next.js or Express: any runtime that speaks Web `Request`/`Response`
 * can mount it (Node 18+, Bun, Deno, Cloudflare Workers, Vercel functions…).
 */

import { handleApi } from "./router.ts";
import { handleMcp } from "./adapters/mcp.ts";
import { HeaderAuthAdapter, roleAtLeast, type AuthAdapter, type HubIdentity } from "./auth.ts";
import { json, withCors } from "./http.ts";

export type HubOptions = {
  /** Identity resolution. Defaults to the header-based adapter. */
  auth?: AuthAdapter;
  /** Mount the API under a prefix, e.g. "/hub" → /hub/api/v1/... and /hub/mcp. */
  basePath?: string;
};

export type HubHandler = (request: Request) => Promise<Response>;

export function createHubHandler(options: HubOptions = {}): HubHandler {
  const auth = options.auth ?? new HeaderAuthAdapter();
  const base = options.basePath?.replace(/\/+$/, "") ?? "";

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;

    if (request.method === "OPTIONS") return withCors(json({ ok: true }));

    let identity: HubIdentity;
    try {
      identity = await auth.identify(request);
    } catch (error) {
      return withCors(json({ error: error instanceof Error ? error.message : "Unauthorized" }, { status: 401 }));
    }

    try {
      if (path === "/mcp" || path === "/api/mcp") {
        return withCors(await handleMcp(request, identity));
      }
      if (path === "/api/v1" || path.startsWith("/api/")) {
        return withCors(await handleApi(request, identity));
      }
      return withCors(json({ error: `Not found: ${path}`, hint: "REST under /api/v1, MCP at /mcp" }, { status: 404 }));
    } catch (error) {
      return withCors(
        json({ error: error instanceof Error ? error.message : "Internal error" }, { status: 500 })
      );
    }
  };
}

export { roleAtLeast };
export type { HubIdentity, AuthAdapter };
