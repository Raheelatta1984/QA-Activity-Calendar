/**
 * REST API v1 — the primary contract of the hub.
 *
 * Every route is a pure function of `(identity, request, params)` so the same
 * table can be served by the standalone Node shell, a Next.js route handler, an
 * Express mount, a Workers script or any other host.
 *
 * Write routes require `editor`; registry/tenant routes require `admin` unless
 * the hub runs key-less (dev mode), where the default editor identity applies.
 */

import { HubError, type Actor } from "./core/service.ts";
import {
  createApplication,
  createEnhancement,
  deleteEnhancement,
  enhancementMarkdown,
  ensureTenant,
  getApplicationBySlug,
  getEnhancement,
  listApplications,
  listEnhancements,
  listTenants,
  listVaultDocs,
  publicApplication,
  publicEnhancement,
  recentAudit,
  setEnhancementStatus,
  syncVaultDocs,
  testApplicationConnector,
  updateEnhancement,
} from "./core/service.ts";
import { draftEnhancement, suggestEnhancementFields, buildHandoverPreview } from "./core/draft.ts";
import { ENHANCEMENT_STATUSES, STATUS_HINTS, STATUS_LABELS, pipelineStages } from "./core/status.ts";
import { roleAtLeast, type HubIdentity } from "./auth.ts";
import { errorResponse, json, readJsonBody } from "./http.ts";

export type RouteParams = Record<string, string>;
export type Handler = (ctx: { identity: HubIdentity; request: Request; params: RouteParams; query: URLSearchParams }) => Promise<Response> | Response;

type Route = { method: string; pattern: RegExp; paramNames: string[]; minRole?: "viewer" | "editor" | "admin"; handler: Handler };

function route(method: string, path: string, handler: Handler, minRole: "viewer" | "editor" | "admin" = "editor"): Route {
  const names: string[] = [];
  const pattern = new RegExp(
    "^" +
      path
        .split("/")
        .map((segment) => {
          if (segment.startsWith(":")) {
            names.push(segment.slice(1));
            return "([^/]+)";
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  return { method, pattern, paramNames: names, minRole, handler };
}

function actorOf(identity: HubIdentity): Actor {
  return { name: identity.actor, role: identity.role };
}

function tenantFor(identity: HubIdentity, query: URLSearchParams, body?: Record<string, any>): string {
  return (body?.tenantSlug || body?.tenant || query.get("tenant") || identity.tenant || "default").trim();
}

export const routes: Route[] = [
  // -- system ---------------------------------------------------------------
  route("GET", "/api/v1/health", () =>
    json({
      ok: true,
      service: "enhancements-hub",
      version: "1.0.0",
      statuses: pipelineStages(),
      vault: process.env.HUB_VAULT_DIR || "./vault",
    })
  ),
  route("GET", "/api/v1/meta", () =>
    json({
      statuses: ENHANCEMENT_STATUSES,
      labels: STATUS_LABELS,
      hints: STATUS_HINTS,
      pipeline: pipelineStages(),
    })
  ),

  // -- registry (admin) ------------------------------------------------------
  route("GET", "/api/v1/tenants", () => json({ tenants: listTenants() }), "viewer"),
  route("POST", "/api/v1/tenants", async ({ identity, request }) => {
    if (!roleAtLeast(identity.role, "admin")) throw new HubError(403, "Admin role required to manage tenants.");
    const body = await readJsonBody(request);
    const tenant = ensureTenant(String(body.slug || tenantFor(identity, new URL(request.url).searchParams)), body.name);
    return json({ tenant }, { status: 201 });
  }),
  route("GET", "/api/v1/applications", ({ query }) => json({ applications: listApplications(query.get("tenant") || undefined).map(publicApplication) }), "viewer"),
  route("POST", "/api/v1/applications", async ({ identity, request }) => {
    if (!roleAtLeast(identity.role, "admin")) throw new HubError(403, "Admin role required to manage the application registry.");
    const body = await readJsonBody(request);
    const app = createApplication({
      tenantSlug: String(body.tenantSlug || body.tenant || tenantFor(identity, new URL(request.url).searchParams)),
      tenantName: body.tenantName,
      slug: String(body.slug || body.name || "app"),
      name: String(body.name || body.slug || "app"),
      description: body.description ?? null,
      githubRepo: body.githubRepo ?? body.github_repo ?? null,
      githubBranch: body.githubBranch ?? body.github_branch ?? undefined,
      handoverDir: body.handoverDir ?? body.handover_dir ?? undefined,
      tokenEnv: body.tokenEnv ?? body.token_env ?? null,
    });
    return json({ application: publicApplication(app) }, { status: 201 });
  }),
  route("POST", "/api/v1/applications/:id/test", async ({ params }) => {
    const result = await testApplicationConnector(params.id);
    return json(result);
  }),

  // -- enhancements -----------------------------------------------------------
  route("GET", "/api/v1/enhancements", ({ query }) => {
    const items = listEnhancements({
      tenantSlug: query.get("tenant") || undefined,
      applicationSlug: query.get("application") || undefined,
      status: query.get("status") || undefined,
      q: query.get("q") || undefined,
      includeArchived: query.get("includeArchived") === "true",
    });
    return json({ enhancements: items.map(publicEnhancement), count: items.length });
  }, "viewer"),
  route("POST", "/api/v1/enhancements", async ({ identity, request, query }) => {
    const body = await readJsonBody(request);
    const result = createEnhancement(actorOf(identity), {
      tenantSlug: tenantFor(identity, query, body),
      applicationSlug: body.applicationSlug || body.application || null,
      title: String(body.title ?? ""),
      brief: String(body.brief ?? ""),
      requirements: body.requirements ?? null,
      impacts: body.impacts ?? null,
      expectedOutcome: body.expectedOutcome ?? null,
      successCriteria: body.successCriteria ?? null,
      sections: body.sections ?? null,
      markdown: body.markdown ?? null,
      aiFields: Array.isArray(body.aiFields) ? body.aiFields.map(String).slice(0, 12) : [],
      status: body.status,
    });
    return json(
      {
        enhancement: publicEnhancement(result.record),
        filename: result.filename,
        vault: result.vault,
        markdown: result.content,
      },
      { status: 201 }
    );
  }),
  route("GET", "/api/v1/enhancements/:id", ({ params }) => {
    const item = getEnhancement(params.id);
    if (!item) throw new HubError(404, "Enhancement not found.");
    return json({ enhancement: publicEnhancement(item) });
  }, "viewer"),
  route("PATCH", "/api/v1/enhancements/:id", async ({ identity, request, params }) => {
    const body = await readJsonBody(request);
    const item = updateEnhancement(actorOf(identity), params.id, {
      title: body.title,
      brief: body.brief,
      requirements: body.requirements,
      impacts: body.impacts,
      expectedOutcome: body.expectedOutcome,
      successCriteria: body.successCriteria,
      sections: body.sections,
      markdown: body.markdown,
    });
    return json({ enhancement: publicEnhancement(item) });
  }),
  route("DELETE", "/api/v1/enhancements/:id", ({ identity, params }) => {
    deleteEnhancement(actorOf(identity), params.id);
    return json({ ok: true });
  }),
  route("GET", "/api/v1/enhancements/:id/markdown", ({ params }) => {
    const item = getEnhancement(params.id);
    if (!item) throw new HubError(404, "Enhancement not found.");
    const { filename, content } = enhancementMarkdown(item);
    return new Response(content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "X-Enhancement-Status": item.status,
        "Cache-Control": "no-store",
      },
    });
  }, "viewer"),
  route("POST", "/api/v1/enhancements/:id/status", async ({ identity, request, params }) => {
    const body = await readJsonBody(request);
    const result = await setEnhancementStatus(actorOf(identity), params.id, String(body.status ?? ""));
    return json({ enhancement: publicEnhancement(result.record), published: result.published });
  }),
  route("POST", "/api/v1/enhancements/:id/archive", async ({ identity, params }) => {
    const result = await setEnhancementStatus(actorOf(identity), params.id, "Archived");
    return json({ enhancement: publicEnhancement(result.record) });
  }),

  // -- drafting engine --------------------------------------------------------
  route("POST", "/api/v1/draft", async ({ request }) => {
    const body = await readJsonBody(request);
    const raw = String(body.raw ?? "").trim();
    if (raw.length < 12) throw new HubError(422, "Add at least a sentence describing the request before drafting.");
    return json({ draft: draftEnhancement({ raw, applicationName: body.applicationName, outcome: body.outcome, submittedBy: body.submittedBy }) });
  }),
  route("POST", "/api/v1/suggest", async ({ request }) => {
    const body = await readJsonBody(request);
    const raw = String(body.raw ?? "").trim();
    if (raw.length < 12) throw new HubError(422, "Keep typing — suggestions start once the request is a sentence or more.");
    const suggestions = suggestEnhancementFields({
      raw,
      applicationName: body.applicationName,
      outcome: body.outcome,
      title: body.title,
      brief: body.brief,
      requirements: body.requirements,
      impacts: body.impacts,
      expectedOutcome: body.expectedOutcome,
      successCriteria: body.successCriteria,
      submittedBy: body.submittedBy,
      departmentName: body.departmentName,
    });
    return json({ suggestions });
  }),
  route("POST", "/api/v1/preview-handover", async ({ request }) => {
    const body = (await readJsonBody(request)) as Record<string, any> & { raw?: string };
    return json({ markdown: buildHandoverPreview({ ...body, raw: String(body.raw ?? "") }) });
  }),

  // -- vault & reconciliation ---------------------------------------------------
  route("GET", "/api/v1/vault", ({ query }) => {
    return json({
      documents: listVaultDocs({
        tenantSlug: query.get("tenant") || undefined,
        applicationSlug: query.get("application") || undefined,
      }),
    });
  }, "viewer"),
  route("POST", "/api/v1/sync", async ({ identity, request, query }) => {
    const body = await readJsonBody(request).catch(() => ({}) as Record<string, any>);
    const result = syncVaultDocs(actorOf(identity), {
      tenantSlug: body.tenant || query.get("tenant") || undefined,
      applicationSlug: body.application || query.get("application") || undefined,
      apply: body.apply !== false && query.get("apply") !== "false",
    });
    return json(result);
  }),

  // -- audit ------------------------------------------------------------------
  route("GET", "/api/v1/audit", ({ query }) => json({ events: recentAudit(Number(query.get("limit") || 50)) }), "viewer"),
];

/** Router used by every host adapter. Throws HubError-shaped HTTP responses. */
export async function handleApi(request: Request, identity: HubIdentity): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const entry of routes) {
    if (entry.method !== request.method) continue;
    const match = entry.pattern.exec(path);
    if (!match) continue;
    if (!roleAtLeast(identity.role, entry.minRole ?? "editor")) {
      return json({ error: `This action requires ${entry.minRole} access.` }, { status: 403 });
    }
    const params: RouteParams = {};
    entry.paramNames.forEach((name, index) => (params[name] = decodeURIComponent(match[index + 1])));
    try {
      return await entry.handler({ identity, request, params, query: url.searchParams });
    } catch (error) {
      return errorResponse(error);
    }
  }
  return json({ error: `No route for ${request.method} ${path}` }, { status: 404 });
}

export { getApplicationBySlug };
