"use server";

import { revalidatePath } from "next/cache";
import { all, get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";
import { draftEnhancement, suggestEnhancementFields, type EnhancementDraft, type EnhancementSuggestions } from "@/lib/ai";
import { publishBuildingEnhancement } from "@/lib/github-enhancements";
import { isoToday } from "@/lib/dates";
import {
  enhancementFileName,
  readEnhancementMarkdown,
  relocateVaultMarkdown,
  removeVaultMarkdown,
  renderEnhancementMarkdown,
  writeVaultMarkdown,
} from "@/lib/enhancements";

export type DraftState = { draft?: EnhancementDraft; error?: string };
export type EnhancementState = { ok?: boolean; error?: string; ref?: string; ephemeral?: boolean; filename?: string; content?: string };
export type SuggestionState = { suggestions?: EnhancementSuggestions; error?: string };

/**
 * Live field suggestions for the studio.
 *
 * Called (debounced) while the author types the "what needs to change" text.
 * It returns 1–3 candidate values per field, computed locally from the same
 * deterministic engine — never a hosted model — and the client only ever
 * applies a suggestion to a field the author has not edited.
 */
export async function suggestEnhancementFieldsAction(input: {
  raw: string;
  area?: string;
  outcome?: string;
  title?: string;
  brief?: string;
  requirements?: string;
  impacts?: string;
  expectedOutcome?: string;
  successCriteria?: string;
  sections?: string;
}): Promise<SuggestionState> {
  const viewer = await getViewer();
  const raw = String(input.raw ?? "").trim();
  if (raw.length < 12) return { error: "Keep typing — suggestions start once the request is a sentence or more." };

  const catalogue = all<{ id: string; label: string; tab_id: string; tab_label: string }>(
    `SELECT s.id, s.label, s.tab_id, t.label AS tab_label
       FROM sections s JOIN tabs t ON t.id = s.tab_id
      WHERE s.enabled = 1 AND t.enabled = 1
      ORDER BY t.sort_order, s.sort_order`
  ).map((row) => ({ id: row.id, label: row.label, tabId: row.tab_id, tabLabel: row.tab_label }));

  const suggestions = suggestEnhancementFields({
    raw,
    area: input.area,
    outcome: input.outcome,
    title: input.title,
    brief: input.brief,
    requirements: input.requirements,
    impacts: input.impacts,
    expectedOutcome: input.expectedOutcome,
    successCriteria: input.successCriteria,
    sections: input.sections,
    departmentName: viewer.org.deptById.get(viewer.person.department_id ?? "")?.name,
    submittedBy: viewer.person.name,
    catalogue,
  });
  return { suggestions };
}

function nextRef(): string {
  const row = get<{ n: number }>(`SELECT COUNT(*) AS n FROM enhancements`);
  let candidate = (row?.n ?? 0) + 1;
  for (let i = 0; i < 1000; i += 1) {
    const ref = `ENH-${String(candidate).padStart(4, "0")}`;
    if (!get(`SELECT 1 FROM enhancements WHERE ref = ?`, ref)) return ref;
    candidate += 1;
  }
  return `ENH-${Date.now()}`;
}

export async function draftEnhancementAction(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const raw = String(formData.get("raw") ?? "").trim();
  if (raw.length < 12) return { error: "Add at least a sentence describing the problem before drafting." };
  const viewer = await getViewer();
  const draft = draftEnhancement({
    raw,
    area: String(formData.get("area") ?? ""),
    outcome: String(formData.get("outcome") ?? ""),
    submittedBy: viewer.person.name,
  });
  return { draft };
}

export async function saveEnhancementAction(_prev: EnhancementState, formData: FormData): Promise<EnhancementState> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const title = String(formData.get("title") ?? "").trim();
  const brief = String(formData.get("brief") ?? "").trim();
  if (!title) return { error: "A title is required." };
  if (!brief) return { error: "A short brief is required." };

  const id = String(formData.get("id") ?? "") || uid("enh");
  const existing = get<any>(`SELECT * FROM enhancements WHERE id = ?`, id);
  const ref = existing?.ref ?? nextRef();
  const rawMarkdown = String(formData.get("markdown") ?? "").trim();
  // Fields the author accepted from the assistant (provenance, not authorship).
  const aiFields = String(formData.get("ai_fields") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);

  const payload = {
    title,
    brief,
    requirements: String(formData.get("requirements") ?? "").trim() || null,
    impacts: String(formData.get("impacts") ?? "").trim() || null,
    expected_outcome: String(formData.get("expected_outcome") ?? "").trim() || null,
    success_criteria: String(formData.get("success_criteria") ?? "").trim() || null,
    department_id: String(formData.get("department_id") ?? "") || null,
    status: String(formData.get("status") ?? "Submitted"),
  };

  const { body: markdown, fileContent } = renderEnhancementMarkdown({
    ref,
    title,
    status: payload.status,
    submittedBy: viewer.person.name,
    submittedOn: isoToday(),
    sections: String(formData.get("sections") ?? ""),
    aiFields,
    rawMarkdown,
    brief,
    requirements: payload.requirements,
    impacts: payload.impacts,
    expectedOutcome: payload.expected_outcome,
    successCriteria: payload.success_criteria,
  });

  const fileName = enhancementFileName(ref, title);
  const vaultWrite = writeVaultMarkdown({
    fileName,
    content: fileContent,
    archived: payload.status === "Archived",
    previousPath: existing?.github_path ?? null,
  });
  const relativePath = vaultWrite.relativePath;

  if (existing) {
    run(
      `UPDATE enhancements SET title = ?, brief = ?, requirements = ?, impacts = ?, expected_outcome = ?, success_criteria = ?,
         markdown = ?, status = ?, department_id = ?, github_path = ?, ai_fields = ?, updated_at = datetime('now') WHERE id = ?`,
      payload.title,
      payload.brief,
      payload.requirements,
      payload.impacts,
      payload.expected_outcome,
      payload.success_criteria,
      markdown,
      payload.status,
      payload.department_id,
      relativePath,
      aiFields.length ? JSON.stringify(aiFields) : null,
      id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "enhancement.update",
      entity: "enhancement",
      entityId: id,
      before: existing.title,
      after: payload.title,
      meta: { ref, relativePath, aiFields, vaultEphemeral: vaultWrite.ephemeral },
    });
  } else {
    run(
      `INSERT INTO enhancements (id, ref, title, brief, requirements, impacts, expected_outcome, success_criteria, markdown,
         status, github_path, submitted_by, department_id, ai_title, ai_model, ai_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      id,
      ref,
      payload.title,
      payload.brief,
      payload.requirements,
      payload.impacts,
      payload.expected_outcome,
      payload.success_criteria,
      markdown,
      payload.status,
      relativePath,
      viewer.person.id,
      payload.department_id,
      String(formData.get("ai_title") ?? "") || null,
      String(formData.get("ai_model") ?? "") || null,
      aiFields.length ? JSON.stringify(aiFields) : null
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "enhancement.create",
      entity: "enhancement",
      entityId: id,
      after: { ref, title: payload.title },
      meta: { relativePath, aiFields, vaultEphemeral: vaultWrite.ephemeral },
    });
  }

  revalidatePath("/enhancements");
  revalidatePath("/", "layout");
  return { ok: true, ref, ephemeral: vaultWrite.ephemeral, filename: fileName, content: fileContent };
}

export async function setEnhancementStatusAction(_prev: { error?: string; ok?: boolean }, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived", "Rejected"];
  if (!allowed.includes(status)) return { error: "Invalid status." };
  const existing = get<any>(
    `SELECT e.*, p.name AS submitted_by_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
      WHERE e.id = ?`,
    id
  );
  if (!existing) return { error: "Enhancement not found on this instance. Refresh and try again." };

  if (status === "Building") {
    const { content } = readEnhancementMarkdown({ ...existing, status });
    const base = enhancementFileName(existing.ref, existing.title).replace(/\.md$/, "");
    const uniqueId = String(existing.id).replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
    try {
      await publishBuildingEnhancement(`${base}-${uniqueId}.md`, content);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "GitHub publishing failed." };
    }
  }

  run(
    `UPDATE enhancements SET status = ?, archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
    status,
    status === "Archived" ? new Date().toISOString() : null,
    id
  );

  // Relocate the markdown into enhancements/archive/ when archived (and back out if reopened),
  // using the writable /tmp fallback whenever the bundle filesystem is read-only.
  if (status === "Archived" || existing.status === "Archived") {
    const { fileContent } = renderEnhancementMarkdown({
      ref: existing.ref,
      title: existing.title,
      status,
      submittedBy: existing.submitted_by_name ?? viewer.person.name,
      submittedOn: existing.created_at ? String(existing.created_at).slice(0, 10) : isoToday(),
      rawMarkdown: existing.markdown,
      brief: existing.brief,
      requirements: existing.requirements,
      impacts: existing.impacts,
      expectedOutcome: existing.expected_outcome,
      successCriteria: existing.success_criteria,
    });
    const relocated = relocateVaultMarkdown({
      githubPath: existing.github_path,
      ref: existing.ref,
      title: existing.title,
      status,
      fallbackContent: fileContent,
    });
    run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, relocated.relativePath, id);
  }

  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "enhancement.status",
    entity: "enhancement",
    entityId: id,
    before: existing.status,
    after: status,
  });
  revalidatePath("/enhancements");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteEnhancementAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const existing = get<any>(`SELECT * FROM enhancements WHERE id = ?`, id);
  if (!existing) return;
  removeVaultMarkdown(existing.github_path);
  run(`DELETE FROM enhancements WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "enhancement.delete",
    entity: "enhancement",
    entityId: id,
    before: existing,
  });
  revalidatePath("/enhancements");
  revalidatePath("/", "layout");
}

export async function regenerateMarkdownAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const item = get<any>(
    `SELECT e.*, p.name AS submitted_by_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
      WHERE e.id = ?`,
    id
  );
  if (!item) return;

  let aiFields: string[] = [];
  if (item.ai_fields) {
    try {
      const parsed = JSON.parse(item.ai_fields);
      if (Array.isArray(parsed)) aiFields = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      /* ignore */
    }
  }

  const fileName = enhancementFileName(item.ref, item.title);
  const { fileContent } = renderEnhancementMarkdown({
    ref: item.ref,
    title: item.title,
    status: item.status,
    submittedBy: item.submitted_by_name ?? viewer.person.name,
    submittedOn: isoToday(),
    aiFields,
    rawMarkdown: item.markdown,
    brief: item.brief,
    requirements: item.requirements,
    impacts: item.impacts,
    expectedOutcome: item.expected_outcome,
    successCriteria: item.success_criteria,
  });
  const written = writeVaultMarkdown({
    fileName,
    content: fileContent,
    archived: item.status === "Archived",
    previousPath: item.github_path,
  });
  run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, written.relativePath, id);
  revalidatePath("/enhancements");
}
