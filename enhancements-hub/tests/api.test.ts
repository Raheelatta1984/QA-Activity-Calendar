/** REST API end-to-end tests against the portable handler (no sockets). */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-api-")), "hub.db");
process.env.DATABASE_FILE = tmpDb;
process.env.HUB_VAULT_DIR = path.join(path.dirname(tmpDb), "vault");
process.env.HUB_AUTH_MODE = "strict";
process.env.HUB_API_KEY = "test-admin-key";
process.env.HUB_READ_KEY = "test-read-key";
delete process.env.GITHUB_TOKEN;

const { createHubHandler } = await import("../server/app.ts");
const { useDatabaseFile } = await import("../server/db.ts");
useDatabaseFile(tmpDb);

const handle = createHubHandler();
const ADMIN = { authorization: "Bearer test-admin-key", "x-actor": "tester" };

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN) {
  return handle(
    new Request(`http://hub.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await req(method, path, body, headers);
  return { status: res.status, data: await res.json() };
}

beforeEach(async () => {
  // heal any cross-test state; tenants/apps are created idempotently per test
});

test("health and meta are open reads", async () => {
  const health = await json("GET", "/api/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.service, "enhancements-hub");
  const meta = await json("GET", "/api/v1/meta");
  assert.equal(meta.data.pipeline.length, 6);
});

test("auth: strict mode rejects unauthenticated writes", async () => {
  const res = await json("POST", "/api/v1/enhancements", { title: "x", brief: "y" }, {});
  assert.equal(res.status, 401);
});

test("auth: read key cannot write", async () => {
  const res = await json("POST", "/api/v1/enhancements", { title: "x", brief: "y" }, { authorization: "Bearer test-read-key" });
  assert.equal(res.status, 403);
});

test("registry: create tenant application with connector", async () => {
  const created = await json("POST", "/api/v1/applications", {
    tenantSlug: "acme",
    slug: "portal",
    name: "Acme Portal",
    githubRepo: "acme/portal",
    tokenEnv: "ACME_PORTAL_TOKEN",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.application.connector.repo, "acme/portal");
  assert.equal(created.data.application.connector.tokenPresent, false, "token absent → not present");

  const dup = await json("POST", "/api/v1/applications", { tenantSlug: "acme", slug: "portal", name: "Dup" });
  assert.equal(dup.status, 409);

  const bad = await json("POST", "/api/v1/applications", { tenantSlug: "acme", slug: "x", name: "X", githubRepo: "not-a-repo" });
  assert.equal(bad.status, 422);
});

test("enhancement: full lifecycle from Submitted to Archived", async () => {
  // A repository-less application runs the whole lifecycle on the local vault.
  await json("POST", "/api/v1/applications", { tenantSlug: "acme", slug: "local", name: "Local App" });

  const created = await json("POST", "/api/v1/enhancements", {
    tenantSlug: "acme",
    applicationSlug: "local",
    title: "Export capacity view",
    brief: "Managers must be able to share the monthly view with delivery leads.",
    aiFields: ["brief"],
  });
  assert.equal(created.status, 201);
  const enh = created.data.enhancement;
  assert.equal(enh.ref, "ENH-0001");
  assert.equal(enh.status, "Submitted");
  assert.match(created.data.filename, /^ENH-0001-export-capacity-view\.md$/);
  assert.ok(created.data.markdown.startsWith("---"));
  assert.ok(created.data.vault.persistedToDisk);

  // second request on the same application increments the ref
  const second = await json("POST", "/api/v1/enhancements", {
    tenantSlug: "acme",
    applicationSlug: "local",
    title: "Another thing",
    brief: "Another brief that is long enough.",
  });
  assert.equal(second.data.enhancement.ref, "ENH-0002");

  // validation
  const bad = await json("POST", "/api/v1/enhancements", { title: "", brief: "" });
  assert.equal(bad.status, 422);
  const missing = await json("POST", "/api/v1/enhancements", { title: "T", brief: "B", applicationSlug: "nope" });
  assert.equal(missing.status, 404);

  // transitions: deliberate decisions, reopen, invalid status
  const reviewing = await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Reviewing" });
  assert.equal(reviewing.data.enhancement.status, "Reviewing");
  const rejected = await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Rejected" });
  assert.equal(rejected.status, 200, "a deliberate Rejected decision is a legal transition");
  const reopen = await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Reviewing" });
  assert.equal(reopen.status, 200, "Rejected can be reopened deliberately");
  const invalidStatus = await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Shipping" });
  assert.equal(invalidStatus.status, 422);

  // Building without a repository → local vault only, no publish attempted
  const building = await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Building" });
  assert.equal(building.status, 200, JSON.stringify(building.data));
  assert.equal(building.data.enhancement.status, "Building");
  assert.equal(building.data.published, null);
  assert.match(building.data.enhancement.github_path, /^acme\/local\/ENH-0001/);

  // Built → archive relocates the vault copy and stamps archived_at
  await json("POST", `/api/v1/enhancements/${enh.id}/status`, { status: "Built" });
  const archived = await json("POST", `/api/v1/enhancements/${enh.id}/archive`);
  assert.equal(archived.data.enhancement.status, "Archived");
  assert.match(archived.data.enhancement.github_path, /archived\/ENH-0001/);

  // markdown download carries archived status
  const md = await req("GET", `/api/v1/enhancements/${enh.id}/markdown`);
  const text = await md.text();
  assert.ok(text.includes('status: "Archived"'));
});

test("connector configured without token → clear 422, transition blocked", async () => {
  const created = await json("POST", "/api/v1/enhancements", {
    tenantSlug: "acme",
    applicationSlug: "portal",
    title: "Portal thing",
    brief: "A brief long enough for the portal application.",
  });
  const portal = created.data.enhancement;
  const blocked = await json("POST", `/api/v1/enhancements/${portal.id}/status`, { status: "Building" });
  assert.equal(blocked.status, 422, "publish failure must block the Building transition");
  assert.match(blocked.data.error, /No GitHub token found/);

  const still = await json("GET", `/api/v1/enhancements/${portal.id}`);
  assert.equal(still.data.enhancement.status, "Submitted", "status unchanged after blocked publish");
});

test("draft and suggest endpoints", async () => {
  const tooShort = await json("POST", "/api/v1/draft", { raw: "short" });
  assert.equal(tooShort.status, 422);
  const draft = await json("POST", "/api/v1/draft", {
    raw: "We need a CSV export on the capacity board so managers can share the monthly view.",
    applicationName: "Capacity",
  });
  assert.equal(draft.status, 200);
  assert.ok(draft.data.draft.title.length > 3);
  const suggest = await json("POST", "/api/v1/suggest", {
    raw: "Add a welcome note when users log in so they see what changed.",
  });
  assert.equal(suggest.status, 200);
  assert.ok(suggest.data.suggestions.brief.length >= 1);
});

test("vault listing and reconciliation endpoints", async () => {
  const docs = await json("GET", "/api/v1/vault?tenant=acme");
  assert.ok(docs.data.documents.length >= 1);
  assert.ok(docs.data.documents.some((d: any) => d.status === "Archived"));

  const sync = await json("POST", "/api/v1/sync", {});
  assert.equal(sync.status, 200);
  assert.ok(sync.data.scanned.active + sync.data.scanned.archived >= 1);
});

test("audit trail records the story", async () => {
  const audit = await json("GET", "/api/v1/audit?limit=100");
  const actions = audit.data.events.map((e: any) => e.action);
  assert.ok(actions.includes("enhancement.create"));
  assert.ok(actions.includes("enhancement.status"));
  assert.ok(actions.includes("application.create"));
});

test("mcp: tools/list and tools/call work over JSON-RPC", async () => {
  const init = await json("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.data.result.serverInfo.name, "enhancements-hub");

  const list = await json("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.data.result.tools.map((t: any) => t.name);
  assert.ok(names.includes("create_enhancement"));
  assert.ok(names.includes("set_status"));
  assert.ok(names.includes("get_markdown"));

  const created = await json("POST", "/mcp", {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "create_enhancement", arguments: { tenant: "acme", application: "portal", title: "From MCP client", brief: "Raised through the MCP endpoint for testing." } },
  });
  const payload = JSON.parse(created.data.result.content[0].text);
  assert.equal(payload.enhancement.ref, "ENH-0002", "portal sequence continues");

  const status = await json("POST", "/mcp", {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "set_status", arguments: { id: payload.enhancement.ref, status: "Reviewing" } },
  });
  const updated = JSON.parse(status.data.result.content[0].text);
  assert.equal(updated.enhancement.status, "Reviewing");

  const markdown = await json("POST", "/mcp", {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "get_markdown", arguments: { id: payload.enhancement.ref } },
  });
  assert.ok(markdown.data.result.content[0].text.includes("ENH-0002"));

  const unknown = await json("POST", "/mcp", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(unknown.data.error.code, -32602);
});

test("multi-tenant isolation: same ref space per application, separate tenants listed", async () => {
  await json("POST", "/api/v1/applications", { tenantSlug: "globex", slug: "site", name: "Globex Site" });
  const theirs = await json("POST", "/api/v1/enhancements", { tenantSlug: "globex", applicationSlug: "site", title: "Globex first", brief: "First request for Globex." });
  assert.equal(theirs.data.enhancement.ref, "ENH-0001", "per-application ref sequence");
  const tenants = await json("GET", "/api/v1/tenants");
  const slugs = tenants.data.tenants.map((t: any) => t.slug);
  assert.ok(slugs.includes("acme") && slugs.includes("globex"));
});
