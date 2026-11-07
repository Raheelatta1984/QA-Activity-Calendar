/**
 * Identity — an adapter interface so the hub never imposes an auth model on the
 * host application, plus a default header-based implementation good enough to
 * run standalone.
 *
 * Host apps with real auth (NextAuth, cookies, OAuth, LDAP…) implement
 * `AuthAdapter.identify` and hand the result to the hub — see INTEGRATION.md.
 */

import { HubError } from "./core/service.ts";

export type HubRole = "viewer" | "editor" | "admin";

export type HubIdentity = {
  actor: string;
  role: HubRole;
  /** Tenant the request operates on (overridable per request via X-Tenant). */
  tenant?: string;
};

export interface AuthAdapter {
  identify(request: Request): HubIdentity | Promise<HubIdentity>;
}

const ROLES: HubRole[] = ["viewer", "editor", "admin"];
export function roleAtLeast(role: HubRole, min: HubRole): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return request.headers.get("x-api-key")?.trim() || null;
}

/**
 * Default adapter:
 *  - `Authorization: Bearer <HUB_API_KEY>` (or `X-Api-Key`) → admin
 *  - `Authorization: Bearer <HUB_READ_KEY>` → viewer (when read access is locked)
 *  - otherwise anonymous viewer, or editor when no keys are configured at all
 *    (local/dev mode), with `X-Actor` naming the actor and `X-Tenant` selecting
 *    the tenant.
 *
 * Mutating requests require editor or above — enforced by the router, not here.
 */
export class HeaderAuthAdapter implements AuthAdapter {
  identify(request: Request): HubIdentity {
    const adminKey = process.env.HUB_API_KEY?.trim();
    const readKey = process.env.HUB_READ_KEY?.trim();
    const key = bearer(request);
    const actor = request.headers.get("x-actor")?.trim() || "anonymous";
    const tenant = request.headers.get("x-tenant")?.trim() || process.env.HUB_DEFAULT_TENANT?.trim() || "default";

    if (key && adminKey && key === adminKey) return { actor, role: "admin", tenant };
    if (key && readKey && key === readKey) return { actor, role: "viewer", tenant };
    if (key) throw new HubError(401, "Invalid API key.");
    if ((process.env.HUB_AUTH_MODE || "").toLowerCase() === "strict") {
      throw new HubError(401, "Authentication required. Set HUB_API_KEY on the server and send it as a bearer token.");
    }
    if (adminKey || readKey) {
      // Keys exist but this request presents none: read-only anonymous access.
      return { actor, role: "viewer", tenant };
    }
    // Key-less dev mode: no auth model is configured at all, so grant full
    // access and warn loudly at boot — the console must be able to manage its
    // own registry in this mode.
    return { actor, role: "admin", tenant };
  }
}
