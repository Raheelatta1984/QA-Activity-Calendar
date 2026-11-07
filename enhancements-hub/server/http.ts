/** Tiny HTTP helpers shared by the REST router, the MCP adapter and the shell. */

import { HubError } from "./core/service.ts";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HubError) {
    return json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[hub] ${message}`);
  return json({ error: "Internal error", detail: message }, { status: 500 });
}

export async function readJsonBody(request: Request): Promise<Record<string, any>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HubError(400, "Request body must be valid JSON.");
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api-Key,X-Actor,X-Tenant",
  "Access-Control-Max-Age": "86400",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
