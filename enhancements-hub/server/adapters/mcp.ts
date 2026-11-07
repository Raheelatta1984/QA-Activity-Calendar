/**
 * MCP adapter — Model Context Protocol (JSON-RPC 2.0) endpoint.
 *
 * This is what makes the hub "work with any git project like MCP": any MCP
 * client (Claude Desktop, an agent runtime, an IDE) can attach to `POST /mcp`
 * and drive the enhancements pipeline as tools — list, create, triage, publish,
 * sync — across every connected tenant/application repository.
 *
 * Endpoints:
 *   initialize      → protocol handshake
 *   tools/list      → the tool catalogue
 *   tools/call      → execute one tool (thin wrapper over core/service.ts)
 *   ping            → liveness
 *
 * Responses follow the MCP result shape: { content: [{ type: "text", text }] }.
 */

import { HubError, createEnhancement, getEnhancement, enhancementMarkdown, listApplications, listEnhancements, publicApplication, publicEnhancement, recentAudit, setEnhancementStatus, syncVaultDocs, listVaultDocs } from "../core/service.ts";
import { draftEnhancement } from "../core/draft.ts";
import { ENHANCEMENT_STATUSES } from "../core/status.ts";
import { readJsonBody } from "../http.ts";
import type { HubIdentity } from "../auth.ts";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method: string; params?: Record<string, any> };

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  run: (args: Record<string, any>, identity: HubIdentity) => Promise<unknown> | unknown;
};

const str = (desc: string) => ({ type: "string", description: desc });

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "list_enhancements",
    description: "List enhancement requests, optionally filtered by tenant, application, status or text search.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: str("Tenant slug (optional)"),
        application: str("Application slug (optional)"),
        status: { type: "string", enum: [...ENHANCEMENT_STATUSES], description: "Filter by lifecycle status (optional)" },
        q: str("Free-text search across title/brief/ref (optional)"),
        includeArchived: { type: "boolean", description: "Include Archived and Rejected requests" },
      },
    },
    run: (args) =>
      listEnhancements({
        tenantSlug: args.tenant || undefined,
        applicationSlug: args.application || undefined,
        status: args.status || undefined,
        q: args.q || undefined,
        includeArchived: args.includeArchived === true,
      }).map(publicEnhancement),
  },
  {
    name: "create_enhancement",
    description: "Raise a new enhancement request against a tenant/application. Title and brief are required; the drafting engine can structure the rest.",
    inputSchema: {
      type: "object",
      required: ["title", "brief"],
      properties: {
        tenant: str("Tenant slug (default: the caller's tenant)"),
        application: str("Application slug (optional — unscoped requests go to the tenant's general vault)"),
        title: str("Short title"),
        brief: str("One-paragraph brief"),
        requirements: str("Requirements, one per line (optional)"),
        impacts: str("Impacted areas (optional)"),
        expectedOutcome: str("Expected outcome (optional)"),
        successCriteria: str("Success criteria, one per line (optional)"),
        sections: str("Impacted tab/section IDs (optional)"),
      },
    },
    run: (args, identity) => {
      const result = createEnhancement({ name: identity.actor, role: identity.role }, {
        tenantSlug: String(args.tenant || identity.tenant || "default"),
        applicationSlug: args.application || null,
        title: String(args.title ?? ""),
        brief: String(args.brief ?? ""),
        requirements: args.requirements ?? null,
        impacts: args.impacts ?? null,
        expectedOutcome: args.expectedOutcome ?? null,
        successCriteria: args.successCriteria ?? null,
        sections: args.sections ?? null,
      });
      return { enhancement: publicEnhancement(result.record), filename: result.filename, vault: result.vault };
    },
  },
  {
    name: "draft_enhancement",
    description: "Run the local drafting engine over a free-text request and return a structured draft (title, brief, requirements, impacts, outcome, criteria).",
    inputSchema: {
      type: "object",
      required: ["raw"],
      properties: {
        raw: str("The raw request text (a sentence or more)"),
        applicationName: str("Application the request is against"),
        outcome: str("Outcome the requester wants"),
      },
    },
    run: (args) => draftEnhancement({ raw: String(args.raw ?? ""), applicationName: args.applicationName, outcome: args.outcome }),
  },
  {
    name: "set_status",
    description: "Move an enhancement through its lifecycle. Building/Built publish the Markdown handover into the application's connected GitHub repository.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: str("Enhancement id or ref (e.g. ENH-0001)"),
        status: { type: "string", enum: [...ENHANCEMENT_STATUSES] },
      },
    },
    run: async (args, identity) => {
      const result = await setEnhancementStatus({ name: identity.actor, role: identity.role }, String(args.id), String(args.status));
      return { enhancement: publicEnhancement(result.record), published: result.published };
    },
  },
  {
    name: "get_markdown",
    description: "Return the Markdown handover document for an enhancement.",
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Enhancement id or ref") } },
    run: (args) => {
      const item = getEnhancement(String(args.id));
      if (!item) throw new HubError(404, "Enhancement not found.");
      return enhancementMarkdown(item);
    },
  },
  {
    name: "list_applications",
    description: "List registered tenant applications and their GitHub connector status (repo, branch, handover dir, token presence). Tokens are never returned.",
    inputSchema: { type: "object", properties: { tenant: str("Tenant slug (optional)") } },
    run: (args) => listApplications(args.tenant || undefined).map(publicApplication),
  },
  {
    name: "list_vault",
    description: "List the handover Markdown documents currently in the vault, per tenant/application.",
    inputSchema: { type: "object", properties: { tenant: str("Tenant slug (optional)"), application: str("Application slug (optional)") } },
    run: (args) => listVaultDocs({ tenantSlug: args.tenant || undefined, applicationSlug: args.application || undefined }),
  },
  {
    name: "sync_vault",
    description: "Reconcile enhancement statuses with the vault documents (an archived file marks the record Archived; a Built file promotes it).",
    inputSchema: { type: "object", properties: { tenant: str("Tenant slug (optional)"), application: str("Application slug (optional)") } },
    run: (args, identity) =>
      syncVaultDocs({ name: identity.actor, role: identity.role }, {
        tenantSlug: args.tenant || undefined,
        applicationSlug: args.application || undefined,
        apply: args.apply !== false,
      }),
  },
  {
    name: "recent_audit",
    description: "Recent audit events — every write the hub performed, with actor and before/after.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max events (default 20)" } } },
    run: (args) => recentAudit(Math.min(Number(args.limit) || 20, 100)),
  },
];

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError: false };
}

/** Serve one JSON-RPC request. `identity` comes from the host auth adapter. */
export async function handleMcp(request: Request, identity: HubIdentity): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await readJsonBody(request)) as unknown as JsonRpcRequest;
  } catch (error) {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  if (body.jsonrpc && body.jsonrpc !== "2.0") {
    return Response.json(rpcError(body.id ?? null, -32600, "jsonrpc must be \"2.0\""), { status: 400 });
  }

  try {
    switch (body.method) {
      case "initialize":
        return Response.json(
          rpcResult(body.id ?? null, {
            protocolVersion: body.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "enhancements-hub", version: "1.0.0" },
          })
        );
      case "notifications/initialized":
        return Response.json(rpcResult(body.id ?? null, {}));
      case "ping":
        return Response.json(rpcResult(body.id ?? null, {}));
      case "tools/list":
        return Response.json(
          rpcResult(
            body.id ?? null,
            { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
          )
        );
      case "tools/call": {
        const name = String(body.params?.name ?? "");
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) return Response.json(rpcError(body.id ?? null, -32602, `Unknown tool: ${name}`), { status: 400 });
        const args = (body.params?.arguments ?? {}) as Record<string, any>;
        const value = await tool.run(args, identity);
        return Response.json(rpcResult(body.id ?? null, toolResult(value)));
      }
      default:
        return Response.json(rpcError(body.id ?? null, -32601, `Method not found: ${body.method}`), { status: 404 });
    }
  } catch (error) {
    const message = error instanceof HubError ? error.message : error instanceof Error ? error.message : String(error);
    return Response.json(rpcError(body.id ?? null, -32000, message), { status: 200 });
  }
}
