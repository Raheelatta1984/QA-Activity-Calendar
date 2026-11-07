/**
 * Enhancement service — the business rules of the Future Enhancements module,
 * expressed as framework-free functions over the data layer.
 *
 * Ported from the source app's `app/actions/enhancements.ts` with the
 * Next.js server-action shell removed: everything here takes an explicit
 * `Actor` (from the host's auth adapter) instead of reading cookies, and
 * returns plain values instead of mutating form state. Both the REST API and
 * the MCP tools are thin wrappers over this file.
 */

import { all, get, run } from "../db.ts";
import { uid } from "../util.ts";
import {
  canTransition,
  isEnhancementStatus,
  statusAfterArchive,
  type EnhancementStatus,
} from "./status.ts";
import {
  enhancementFileName,
  handoverFileName,
  parseAiFields,
  renderEnhancementMarkdown,
} from "./markdown.ts";
import {
  relocateVaultMarkdown,
  removeVaultMarkdown,
  scanHandoverDocs,
  syncScopeDocs,
  writeVaultMarkdown,
  type HandoverDoc,
} from "./vault.ts";
import { connectorSummary, publishHandover, testConnector, type ConnectorConfig } from "./github.ts";

export type Actor = { name: string; role: "viewer" | "editor" | "admin" };

export type ApplicationRow = {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  github_repo: string | null;
  github_branch: string;
  handover_dir: string;
  token_env: string | null;
  enabled: number;
  created_at: string;
  tenant_slug?: string;
  tenant_name?: string;
};

export type EnhancementRow = {
  id: string;
  tenant_id: string;
  application_id: string | null;
  ref: string;
  title: string;
  brief: string | null;
  requirements: string | null;
  impacts: string | null;
  expected_outcome: string | null;
  success_criteria: string | null;
  sections: string | null;
  markdown: string | null;
  status: string;
  github_path: string | null;
  submitted_by: string | null;
  ai_fields: string | null;
  votes: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  application_name?: string | null;
  application_slug?: string | null;
  tenant_slug?: string | null;
  tenant_name?: string | null;
};

export class HubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Tenants & applications (the connector registry)
// ---------------------------------------------------------------------------

export function ensureTenant(slug: string, name?: string): { id: string; slug: string; name: string } {
  const clean = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  const existing = get<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM tenants WHERE slug = ?`, clean);
  if (existing) return existing;
  const id = uid("tnt");
  run(`INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)`, id, clean, name?.trim() || clean);
  return { id, slug: clean, name: name?.trim() || clean };
}

export function listTenants() {
  return all(`SELECT t.*, (SELECT COUNT(*) FROM applications a WHERE a.tenant_id = t.id) AS application_count FROM tenants t ORDER BY t.name`);
}

export function listApplications(tenantSlug?: string) {
  if (tenantSlug) {
    return all<ApplicationRow>(
      `SELECT a.*, t.slug AS tenant_slug, t.name AS tenant_name
         FROM applications a JOIN tenants t ON t.id = a.tenant_id
        WHERE t.slug = ?
        ORDER BY t.name, a.name`,
      tenantSlug
    );
  }
  return all<ApplicationRow>(
    `SELECT a.*, t.slug AS tenant_slug, t.name AS tenant_name
       FROM applications a JOIN tenants t ON t.id = a.tenant_id
      ORDER BY t.name, a.name`
  );
}

export function getApplicationBySlug(tenantSlug: string, applicationSlug: string): ApplicationRow | undefined {
  return get<ApplicationRow>(
    `SELECT a.*, t.slug AS tenant_slug, t.name AS tenant_name
       FROM applications a JOIN tenants t ON t.id = a.tenant_id
      WHERE t.slug = ? AND a.slug = ?`,
    tenantSlug,
    applicationSlug
  );
}

export function createApplication(input: {
  tenantSlug: string;
  tenantName?: string;
  slug: string;
  name: string;
  description?: string | null;
  githubRepo?: string | null;
  githubBranch?: string;
  handoverDir?: string;
  tokenEnv?: string | null;
}): ApplicationRow {
  const tenant = ensureTenant(input.tenantSlug, input.tenantName);
  const slug =
    input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  const existing = getApplicationBySlug(tenant.slug, slug);
  if (existing) throw new HubError(409, `Application "${slug}" already exists for tenant "${tenant.slug}".`);
  if (input.githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(input.githubRepo)) {
    throw new HubError(422, "github_repo must look like owner/name.");
  }
  const id = uid("app");
  run(
    `INSERT INTO applications (id, tenant_id, slug, name, description, github_repo, github_branch, handover_dir, token_env)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    tenant.id,
    slug,
    input.name.trim(),
    input.description?.trim() || null,
    input.githubRepo?.trim() || null,
    (input.githubBranch?.trim() || "main"),
    (input.handoverDir?.trim() || "future-enhancements"),
    input.tokenEnv?.trim() || null
  );
  recordAudit({ tenantId: tenant.id, actor: "system", action: "application.create", entity: "application", entityId: id, after: { slug, repo: input.githubRepo ?? null } });
  return getApplicationBySlug(tenant.slug, slug)!;
}

export function connectorFor(app: ApplicationRow): ConnectorConfig {
  return {
    repo: app.github_repo,
    branch: app.github_branch || "main",
    handoverDir: app.handover_dir || "future-enhancements",
    tokenEnv: app.token_env,
  };
}

export async function testApplicationConnector(applicationId: string) {
  const app = get<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, applicationId);
  if (!app) throw new HubError(404, "Application not found.");
  const result = await testConnector(connectorFor(app));
  recordAudit({ tenantId: app.tenant_id, actor: "system", action: "application.test", entity: "application", entityId: applicationId, meta: result });
  return { application: publicApplication(app), connector: result };
}

// ---------------------------------------------------------------------------
// Enhancements
// ---------------------------------------------------------------------------

const STATUS_ORDER = `CASE e.status WHEN 'Reviewing' THEN 1 WHEN 'Submitted' THEN 2 WHEN 'Accepted' THEN 3
                       WHEN 'Building' THEN 4 WHEN 'Built' THEN 5 WHEN 'Archived' THEN 6 ELSE 7 END`;

function enrichRow(row: EnhancementRow | undefined): EnhancementRow | undefined {
  if (!row) return undefined;
  const joined = get<{ application_name: string | null; application_slug: string | null; tenant_slug: string; tenant_name: string }>(
    `SELECT a.name AS application_name, a.slug AS application_slug, t.slug AS tenant_slug, t.name AS tenant_name
       FROM tenants t
       LEFT JOIN applications a ON a.id = ?
      WHERE t.id = ?`,
    row.application_id,
    row.tenant_id
  );
  return { ...row, ...joined };
}

export function listEnhancements(filter: { tenantSlug?: string; applicationSlug?: string; status?: string; q?: string; includeArchived?: boolean } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.tenantSlug) {
    where.push(`t.slug = ?`);
    params.push(filter.tenantSlug);
  }
  if (filter.applicationSlug) {
    where.push(`a.slug = ?`);
    params.push(filter.applicationSlug);
  }
  if (filter.status && isEnhancementStatus(filter.status)) {
    where.push(`e.status = ?`);
    params.push(filter.status);
  } else if (!filter.includeArchived) {
    where.push(`e.status NOT IN ('Archived', 'Rejected')`);
  }
  if (filter.q) {
    where.push(`(e.title LIKE ? OR e.brief LIKE ? OR e.ref LIKE ?)`);
    const like = `%${filter.q}%`;
    params.push(like, like, like);
  }
  const sql = `
    SELECT e.*, a.name AS application_name, a.slug AS application_slug, t.slug AS tenant_slug, t.name AS tenant_name
      FROM enhancements e
      JOIN tenants t ON t.id = e.tenant_id
      LEFT JOIN applications a ON a.id = e.application_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${STATUS_ORDER}, e.created_at DESC`;
  return all<EnhancementRow>(sql, ...params).map((row) => row);
}

export function getEnhancement(idOrRef: string): EnhancementRow | undefined {
  const row = get<EnhancementRow>(
    `SELECT e.*, a.name AS application_name, a.slug AS application_slug, t.slug AS tenant_slug, t.name AS tenant_name
       FROM enhancements e
       JOIN tenants t ON t.id = e.tenant_id
       LEFT JOIN applications a ON a.id = e.application_id
      WHERE e.id = ? OR e.ref = ?
      ORDER BY CASE WHEN e.id = ? THEN 0 ELSE 1 END
      LIMIT 1`,
    idOrRef,
    idOrRef,
    idOrRef
  );
  return enrichRow(row);
}

function nextRef(applicationId: string | null): string {
  const scope = applicationId ? `application_id = ?` : `application_id IS NULL`;
  const params: any[] = applicationId ? [applicationId] : [];
  const row = get<{ n: number }>(`SELECT COUNT(*) AS n FROM enhancements WHERE ${scope}`, ...params);
  let candidate = (row?.n ?? 0) + 1;
  for (let i = 0; i < 1000; i += 1) {
    const ref = `ENH-${String(candidate).padStart(4, "0")}`;
    const clash = applicationId
      ? get(`SELECT 1 FROM enhancements WHERE ref = ? AND application_id = ?`, ref, applicationId)
      : get(`SELECT 1 FROM enhancements WHERE ref = ? AND application_id IS NULL`, ref);
    if (!clash) return ref;
    candidate += 1;
  }
  return `ENH-${Date.now()}`;
}

function scopeSlugs(row: EnhancementRow): { tenantSlug: string; applicationSlug: string } {
  return {
    tenantSlug: row.tenant_slug || "default",
    applicationSlug: row.application_slug || "general",
  };
}

export function createEnhancement(
  actor: Actor,
  input: {
    tenantSlug: string;
    applicationSlug?: string | null;
    title: string;
    brief: string;
    requirements?: string | null;
    impacts?: string | null;
    expectedOutcome?: string | null;
    successCriteria?: string | null;
    sections?: string | null;
    markdown?: string | null;
    aiFields?: string[];
    status?: string;
  }
): { record: EnhancementRow; filename: string; content: string; vault: { relativePath: string; ephemeral: boolean; persistedToDisk: boolean } } {
  if (!input.title?.trim()) throw new HubError(422, "A title is required.");
  if (!input.brief?.trim()) throw new HubError(422, "A short brief is required.");
  const status = input.status && isEnhancementStatus(input.status) ? input.status : "Submitted";

  const app = input.applicationSlug
    ? getApplicationBySlug(input.tenantSlug, input.applicationSlug)
    : undefined;
  if (input.applicationSlug && !app) throw new HubError(404, `Application "${input.applicationSlug}" not found for tenant "${input.tenantSlug}".`);

  const tenant = ensureTenant(input.tenantSlug);
  const id = uid("enh");
  const ref = nextRef(app?.id ?? null);
  const tenantName = (get<{ name: string }>(`SELECT name FROM tenants WHERE id = ?`, tenant.id))?.name || tenant.slug;

  const { body: markdownBody, fileContent } = renderEnhancementMarkdown({
    ref,
    title: input.title.trim(),
    status,
    applicationName: app?.name ?? null,
    tenantName,
    submittedBy: actor.name,
    submittedOn: new Date().toISOString().slice(0, 10),
    sections: input.sections ?? null,
    aiFields: input.aiFields ?? [],
    rawMarkdown: input.markdown ?? null,
    brief: input.brief.trim(),
    requirements: input.requirements ?? null,
    impacts: input.impacts ?? null,
    expectedOutcome: input.expectedOutcome ?? null,
    successCriteria: input.successCriteria ?? null,
  });

  const fileName = enhancementFileName(ref, input.title.trim());
  const vaultWrite = writeVaultMarkdown({
    tenantSlug: tenant.slug,
    applicationSlug: app?.slug ?? "general",
    fileName,
    content: fileContent,
    archived: status === "Archived",
  });

  run(
    `INSERT INTO enhancements (id, tenant_id, application_id, ref, title, brief, requirements, impacts, expected_outcome, success_criteria,
       sections, markdown, status, github_path, submitted_by, ai_fields, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    id,
    tenant.id,
    app?.id ?? null,
    ref,
    input.title.trim(),
    input.brief.trim(),
    input.requirements?.trim() || null,
    input.impacts?.trim() || null,
    input.expectedOutcome?.trim() || null,
    input.successCriteria?.trim() || null,
    input.sections?.trim() || null,
    markdownBody,
    status,
    vaultWrite.relativePath,
    actor.name,
    input.aiFields?.length ? JSON.stringify(input.aiFields) : null
  );
  recordAudit({
    tenantId: tenant.id,
    actor: actor.name,
    action: "enhancement.create",
    entity: "enhancement",
    entityId: id,
    after: { ref, title: input.title.trim() },
    meta: { relativePath: vaultWrite.relativePath, aiFields: input.aiFields ?? [], vaultEphemeral: vaultWrite.ephemeral },
  });

  const record = getEnhancement(id)!;
  return {
    record,
    filename: fileName,
    content: fileContent,
    vault: { relativePath: vaultWrite.relativePath, ephemeral: vaultWrite.ephemeral, persistedToDisk: vaultWrite.persistedToDisk },
  };
}

export function updateEnhancement(
  actor: Actor,
  id: string,
  patch: {
    title?: string;
    brief?: string;
    requirements?: string | null;
    impacts?: string | null;
    expectedOutcome?: string | null;
    successCriteria?: string | null;
    sections?: string | null;
    markdown?: string | null;
  }
): EnhancementRow {
  const existing = getEnhancement(id);
  if (!existing) throw new HubError(404, "Enhancement not found.");
  const title = patch.title?.trim() || existing.title;
  const brief = patch.brief?.trim() || existing.brief || "";
  if (!title) throw new HubError(422, "A title is required.");
  if (!brief) throw new HubError(422, "A short brief is required.");

  const { body: markdownBody, fileContent } = renderEnhancementMarkdown({
    ref: existing.ref,
    title,
    status: existing.status,
    applicationName: existing.application_name,
    tenantName: existing.tenant_name,
    submittedBy: existing.submitted_by,
    submittedOn: existing.created_at?.slice(0, 10),
    sections: patch.sections ?? existing.sections,
    aiFields: parseAiFields(existing.ai_fields),
    rawMarkdown: patch.markdown ?? existing.markdown,
    brief,
    requirements: patch.requirements ?? existing.requirements,
    impacts: patch.impacts ?? existing.impacts,
    expectedOutcome: patch.expectedOutcome ?? existing.expected_outcome,
    successCriteria: patch.successCriteria ?? existing.success_criteria,
  });

  const { tenantSlug, applicationSlug } = scopeSlugs(existing);
  const vaultWrite = writeVaultMarkdown({
    tenantSlug,
    applicationSlug,
    fileName: enhancementFileName(existing.ref, title),
    content: fileContent,
    archived: existing.status === "Archived",
    previousPath: existing.github_path,
  });

  run(
    `UPDATE enhancements SET title = ?, brief = ?, requirements = ?, impacts = ?, expected_outcome = ?, success_criteria = ?,
       sections = ?, markdown = ?, github_path = ?, updated_at = datetime('now') WHERE id = ?`,
    title,
    brief,
    patch.requirements ?? existing.requirements,
    patch.impacts ?? existing.impacts,
    patch.expectedOutcome ?? existing.expected_outcome,
    patch.successCriteria ?? existing.success_criteria,
    patch.sections ?? existing.sections,
    markdownBody,
    vaultWrite.relativePath,
    existing.id
  );
  recordAudit({
    tenantId: existing.tenant_id,
    actor: actor.name,
    action: "enhancement.update",
    entity: "enhancement",
    entityId: existing.id,
    before: { title: existing.title },
    after: { title },
    meta: { relativePath: vaultWrite.relativePath },
  });
  return getEnhancement(existing.id)!;
}

/**
 * Move a request through the lifecycle.
 *
 * `Building`/`Built` publish the handover into the target repository when the
 * application has a GitHub connector; without one the request still transitions
 * and the file lands in the local vault. `Archived` relocates the local
 * Markdown into archived/ and stamps archived_at.
 */
export async function setEnhancementStatus(
  actor: Actor,
  id: string,
  status: string
): Promise<{ record: EnhancementRow; published: { filePath: string; url: string } | null }> {
  if (!isEnhancementStatus(status)) throw new HubError(422, `Invalid status "${status}".`);
  const existing = getEnhancement(id);
  if (!existing) throw new HubError(404, "Enhancement not found.");
  if (!canTransition(existing.status, status)) {
    throw new HubError(409, `Cannot move a ${existing.status} request to ${status}.`);
  }

  let published: { filePath: string; url: string } | null = null;

  if (status === "Building" || status === "Built") {
    // Re-render with the target status so the published frontmatter is truthful.
    const { fileContent } = renderEnhancementMarkdown({
      ref: existing.ref,
      title: existing.title,
      status,
      applicationName: existing.application_name,
      tenantName: existing.tenant_name,
      submittedBy: existing.submitted_by,
      submittedOn: existing.created_at?.slice(0, 10),
      sections: existing.sections,
      aiFields: parseAiFields(existing.ai_fields),
      rawMarkdown: existing.markdown,
      brief: existing.brief,
      requirements: existing.requirements,
      impacts: existing.impacts,
      expectedOutcome: existing.expected_outcome,
      successCriteria: existing.success_criteria,
    });
    const { tenantSlug, applicationSlug } = scopeSlugs(existing);
    const appRow = existing.application_id
      ? get<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, existing.application_id)
      : undefined;
    const fileName = handoverFileName(existing.ref, existing.title, existing.id);

    // Always keep the local vault copy (that is what reconciliation reads).
    const localWrite = writeVaultMarkdown({
      tenantSlug,
      applicationSlug,
      fileName,
      content: fileContent,
      archived: false,
      previousPath: existing.github_path,
    });

    if (appRow?.github_repo) {
      try {
        published = await publishHandover(connectorFor(appRow), fileName, fileContent);
      } catch (error) {
        // A Building/Built request MUST have its handover published — the whole
        // vault-reconciliation contract depends on it — so a connector failure
        // blocks the transition with an actionable message (source-app contract).
        throw new HubError(
          422,
          `${error instanceof Error ? error.message : "GitHub publishing failed."}${
            status === "Built" ? " A Built request needs its handover published so the completion automation can archive it." : ""
          }`
        );
      }
    }
    run(
      `UPDATE enhancements SET status = ?, github_path = ?, updated_at = datetime('now') WHERE id = ?`,
      status,
      published ? published.filePath : localWrite.relativePath,
      existing.id
    );
  } else {
    const archived = status === "Archived";
    run(
      `UPDATE enhancements SET status = ?, archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
      status,
      archived ? new Date().toISOString() : null,
      existing.id
    );
    if (archived || existing.status === "Archived") {
      const { fileContent } = renderEnhancementMarkdown({
        ref: existing.ref,
        title: existing.title,
        status,
        applicationName: existing.application_name,
        tenantName: existing.tenant_name,
        submittedBy: existing.submitted_by,
        submittedOn: existing.created_at?.slice(0, 10),
        rawMarkdown: existing.markdown,
        brief: existing.brief,
        requirements: existing.requirements,
        impacts: existing.impacts,
        expectedOutcome: existing.expected_outcome,
        successCriteria: existing.success_criteria,
      });
      const { tenantSlug, applicationSlug } = scopeSlugs(existing);
      const relocated = relocateVaultMarkdown({
        tenantSlug,
        applicationSlug,
        githubPath: existing.github_path,
        ref: existing.ref,
        title: existing.title,
        status,
        fallbackContent: fileContent,
      });
      run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, relocated.relativePath, existing.id);
    }
  }

  recordAudit({
    tenantId: existing.tenant_id,
    actor: actor.name,
    action: "enhancement.status",
    entity: "enhancement",
    entityId: existing.id,
    before: existing.status,
    after: status,
    meta: published ? { published: published.filePath } : undefined,
  });
  return { record: getEnhancement(existing.id)!, published };
}

export function deleteEnhancement(actor: Actor, id: string): void {
  const existing = getEnhancement(id);
  if (!existing) throw new HubError(404, "Enhancement not found.");
  const { tenantSlug, applicationSlug } = scopeSlugs(existing);
  removeVaultMarkdown(tenantSlug, applicationSlug, existing.github_path);
  run(`DELETE FROM enhancements WHERE id = ?`, existing.id);
  recordAudit({
    tenantId: existing.tenant_id,
    actor: actor.name,
    action: "enhancement.delete",
    entity: "enhancement",
    entityId: existing.id,
    before: { ref: existing.ref, title: existing.title, status: existing.status },
  });
}

export function enhancementMarkdown(item: EnhancementRow): { filename: string; content: string } {
  const filename = item.github_path ? item.github_path.split("/").pop()! : enhancementFileName(item.ref, item.title);
  const rendered = renderEnhancementMarkdown({
    ref: item.ref,
    title: item.title,
    status: statusAfterArchive(item.status),
    applicationName: item.application_name,
    tenantName: item.tenant_name,
    submittedBy: item.submitted_by,
    submittedOn: item.created_at?.slice(0, 10),
    sections: item.sections,
    aiFields: parseAiFields(item.ai_fields),
    rawMarkdown: item.markdown,
    brief: item.brief,
    requirements: item.requirements,
    impacts: item.impacts,
    expectedOutcome: item.expected_outcome,
    successCriteria: item.success_criteria,
    includeFooter: false,
  });
  return { filename, content: rendered.fileContent };
}

// ---------------------------------------------------------------------------
// Vault reconciliation
// ---------------------------------------------------------------------------

export function listVaultDocs(filter: { tenantSlug?: string; applicationSlug?: string } = {}): HandoverDoc[] {
  const apps = filter.tenantSlug
    ? listApplications(filter.tenantSlug)
    : listApplications();
  const docs: HandoverDoc[] = [];
  for (const app of apps) {
    if (filter.applicationSlug && app.slug !== filter.applicationSlug) continue;
    const { active, archived } = scanHandoverDocs({ tenantSlug: app.tenant_slug!, applicationSlug: app.slug });
    docs.push(...active, ...archived);
  }
  return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function syncVaultDocs(
  actor: Actor,
  filter: { tenantSlug?: string; applicationSlug?: string; apply?: boolean } = {}
): { changes: ReturnType<typeof syncScopeDocs>["changes"]; scanned: { active: number; archived: number } } {
  const exec = { all, run };
  const changes: any[] = [];
  let scanned = { active: 0, archived: 0 };
  for (const app of listApplications(filter.tenantSlug)) {
    if (filter.applicationSlug && app.slug !== filter.applicationSlug) continue;
    const result = syncScopeDocs({ tenantSlug: app.tenant_slug!, applicationSlug: app.slug }, exec, { apply: filter.apply !== false });
    changes.push(...result.changes);
    scanned.active += result.scanned.active;
    scanned.archived += result.scanned.archived;
  }
  if (changes.length) {
    recordAudit({
      tenantId: null,
      actor: actor.name,
      action: "enhancement.sync",
      entity: "enhancement",
      after: changes.map((c) => ({ ref: c.ref, from: c.from, to: c.to, source: c.source })),
    });
  }
  return { changes, scanned };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function recordAudit(input: {
  tenantId?: string | null;
  actor: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown> | undefined;
}) {
  run(
    `INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, before_json, after_json, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid("aud"),
    input.tenantId ?? null,
    input.actor,
    input.action,
    input.entity,
    input.entityId ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.meta ? JSON.stringify(input.meta) : null
  );
}

export function recentAudit(limit = 50) {
  return all(
    `SELECT id, tenant_id, actor, action, entity, entity_id, before_json, after_json, meta, at
       FROM audit_events ORDER BY at DESC, id DESC LIMIT ?`,
    Math.max(1, Math.min(limit, 500))
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function publicApplication(app: ApplicationRow) {
  return {
    id: app.id,
    tenant: app.tenant_slug,
    slug: app.slug,
    name: app.name,
    description: app.description,
    connector: connectorSummary({
      repo: app.github_repo,
      branch: app.github_branch,
      handoverDir: app.handover_dir,
      tokenEnv: app.token_env,
    }),
    enabled: Boolean(app.enabled),
    created_at: app.created_at,
  };
}

export function publicEnhancement(row: EnhancementRow) {
  return {
    id: row.id,
    ref: row.ref,
    tenant: row.tenant_slug,
    application: row.application_slug,
    application_name: row.application_name,
    title: row.title,
    brief: row.brief,
    requirements: row.requirements,
    impacts: row.impacts,
    expected_outcome: row.expected_outcome,
    success_criteria: row.success_criteria,
    sections: row.sections,
    status: row.status,
    github_path: row.github_path,
    submitted_by: row.submitted_by,
    ai_fields: parseAiFields(row.ai_fields),
    votes: row.votes,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
