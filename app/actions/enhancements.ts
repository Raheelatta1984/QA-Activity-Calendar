"use server";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { all, get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";
import { draftEnhancement, type EnhancementDraft } from "@/lib/ai";
import { isoToday } from "@/lib/dates";

export type DraftState = { draft?: EnhancementDraft; error?: string };
export type EnhancementState = { ok?: boolean; error?: string; ref?: string };

const VAULT = path.join(process.cwd(), "enhancements");

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
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

function frontmatter(meta: Record<string, string | number | null | undefined>) {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: "${String(value).replace(/"/g, "'")}"`);
  return `---\n${lines.join("\n")}\n---\n`;
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

  const markdown =
    rawMarkdown ||
    `# ${title}\n\n## Brief\n${brief}\n\n## Requirements\n${payload.requirements ?? "_To be confirmed_"}\n\n## Impacts\n${
      payload.impacts ?? "_To be confirmed_"
    }\n\n## Expected outcome\n${payload.expected_outcome ?? "_To be confirmed_"}\n\n## Success criteria\n${
      payload.success_criteria ?? "_To be confirmed_"
    }\n`;

  const fileName = `${ref}-${slugify(title) || "enhancement"}.md`;
  const relativePath = `enhancements/${fileName}`;
  const fullPath = path.join(VAULT, fileName);
  const fileContent = `${frontmatter({
    ref,
    title,
    status: payload.status,
    submitted_by: viewer.person.name,
    submitted_on: isoToday(),
    app_sections: String(formData.get("sections") ?? ""),
    source: "HFM QA Calendar — Future Enhancements",
  })}${markdown}\n\n---\n\n_Generated from the in-app enhancement vault. Review with every change set and archive once built and tested._\n`;

  try {
    fs.mkdirSync(VAULT, { recursive: true });
    fs.writeFileSync(fullPath, fileContent, "utf8");
  } catch (error) {
    return { error: `Could not write the markdown vault: ${(error as Error).message}` };
  }

  if (existing) {
    run(
      `UPDATE enhancements SET title = ?, brief = ?, requirements = ?, impacts = ?, expected_outcome = ?, success_criteria = ?,
         markdown = ?, status = ?, department_id = ?, github_path = ?, updated_at = datetime('now') WHERE id = ?`,
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
      meta: { ref, relativePath },
    });
  } else {
    run(
      `INSERT INTO enhancements (id, ref, title, brief, requirements, impacts, expected_outcome, success_criteria, markdown,
         status, github_path, submitted_by, department_id, ai_title, ai_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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
      String(formData.get("ai_model") ?? "") || null
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "enhancement.create",
      entity: "enhancement",
      entityId: id,
      after: { ref, title: payload.title },
      meta: { relativePath },
    });
  }

  revalidatePath("/enhancements");
  return { ok: true, ref };
}

export async function setEnhancementStatusAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const allowed = ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived", "Rejected"];
  if (!allowed.includes(status)) return;
  const existing = get<any>(`SELECT * FROM enhancements WHERE id = ?`, id);
  if (!existing) return;

  run(
    `UPDATE enhancements SET status = ?, archived_at = ?, updated_at = datetime('now') WHERE id = ?`,
    status,
    status === "Archived" ? new Date().toISOString() : null,
    id
  );

  // Archive the markdown out of the active vault so it is not reviewed again.
  if (status === "Archived" && existing.github_path) {
    try {
      const source = path.join(process.cwd(), existing.github_path);
      const archiveDir = path.join(VAULT, "archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      if (fs.existsSync(source)) {
        const target = path.join(archiveDir, path.basename(existing.github_path));
        fs.renameSync(source, target);
        run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, `enhancements/archive/${path.basename(target)}`, id);
      }
    } catch (error) {
      console.error("[enhancements] archive move failed", error);
    }
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
}

export async function deleteEnhancementAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const existing = get<any>(`SELECT * FROM enhancements WHERE id = ?`, id);
  if (!existing) return;
  if (existing.github_path) {
    try {
      const full = path.join(process.cwd(), existing.github_path);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* file cleanup is best-effort */
    }
  }
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
}

export async function regenerateMarkdownAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const item = get<any>(`SELECT * FROM enhancements WHERE id = ?`, id);
  if (!item) return;
  const fileName = `${item.ref}-${slugify(item.title) || "enhancement"}.md`;
  const relativePath = `enhancements/${fileName}`;
  fs.mkdirSync(VAULT, { recursive: true });
  const content = `${frontmatter({
    ref: item.ref,
    title: item.title,
    status: item.status,
    submitted_by: viewer.person.name,
    submitted_on: isoToday(),
    source: "HFM QA Calendar — Future Enhancements",
  })}${item.markdown ?? `# ${item.title}`}\n`;
  fs.writeFileSync(path.join(VAULT, fileName), content, "utf8");
  run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, relativePath, id);
  revalidatePath("/enhancements");
}
