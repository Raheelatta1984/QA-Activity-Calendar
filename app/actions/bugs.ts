"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { isIsoDate } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";

export type BugResult = { ok?: boolean; error?: string };

export async function saveBugAction(_prev: BugResult, formData: FormData): Promise<BugResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const id = String(formData.get("id") ?? "") || null;
  const key = String(formData.get("bug_key") ?? "").trim().toUpperCase();
  const title = String(formData.get("title") ?? "").trim();
  if (!key) return { error: "Bug ID is required (e.g. HFM-1052)." };
  if (!title) return { error: "A short title is required." };

  const duplicate = get<{ id: string }>(`SELECT id FROM bugs WHERE UPPER(bug_key) = ? AND id <> ?`, key, id ?? "");
  if (duplicate) return { error: `Bug ID ${key} already exists. Use the existing row or a new ID.` };

  const reportedDate = String(formData.get("reported_date") ?? "") || null;
  if (reportedDate && !isIsoDate(reportedDate)) return { error: "Reported date is invalid." };

  const services = formData.getAll("service_ids").map(String).filter(Boolean);
  const statuses = formData.getAll("service_status").map(String);
  const severity = String(formData.get("severity") ?? "Medium");
  const status = String(formData.get("status") ?? "Open");

  const payload = {
    bug_key: key,
    title,
    severity,
    status,
    reported_date: reportedDate,
    activity_id: String(formData.get("activity_id") ?? "") || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
  };

  if (id) {
    const before = get<any>("SELECT * FROM bugs WHERE id = ?", id);
    if (!before) return { error: "Bug no longer exists." };
    run(
      `UPDATE bugs SET bug_key = ?, title = ?, severity = ?, status = ?, reported_date = ?, activity_id = ?, notes = ? WHERE id = ?`,
      payload.bug_key,
      payload.title,
      payload.severity,
      payload.status,
      payload.reported_date,
      payload.activity_id,
      payload.notes,
      id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "bug.update",
      entity: "bug",
      entityId: id,
      before,
      after: payload,
    });
  } else {
    const newId = uid("bug");
    run(
      `INSERT INTO bugs (id, bug_key, title, severity, status, reported_date, reported_by, activity_id, notes, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      newId,
      payload.bug_key,
      payload.title,
      payload.severity,
      payload.status,
      payload.reported_date,
      viewer.person.id,
      payload.activity_id,
      payload.notes
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "bug.create",
      entity: "bug",
      entityId: newId,
      after: payload,
    });
  }

  const bugId = id ?? get<{ id: string }>(`SELECT id FROM bugs WHERE bug_key = ?`, payload.bug_key)!.id;
  if (services.length) {
    run(`DELETE FROM bug_service_links WHERE bug_id = ?`, bugId);
    services.forEach((serviceId, index) => {
      run(
        `INSERT INTO bug_service_links (id, bug_id, service_id, status) VALUES (?, ?, ?, ?)`,
        uid("bsl"),
        bugId,
        serviceId,
        statuses[index] || "Open"
      );
    });
  }

  revalidatePath(String(formData.get("path") ?? "/reporting"));
  revalidatePath("/");
  return { ok: true };
}

export async function deleteBugAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const before = get<any>("SELECT * FROM bugs WHERE id = ?", id);
  if (!before) return;
  run(`DELETE FROM bugs WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "bug.delete",
    entity: "bug",
    entityId: id,
    before,
  });
  revalidatePath("/reporting");
  revalidatePath("/");
}

export async function setBugLinkStatusAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const bugId = String(formData.get("bug_id") ?? "");
  const serviceId = String(formData.get("service_id") ?? "");
  const status = String(formData.get("status") ?? "Open");
  const link = get<any>(
    `SELECT * FROM bug_service_links WHERE bug_id = ? AND service_id = ?`,
    bugId,
    serviceId
  );
  if (!link) return;
  run(`UPDATE bug_service_links SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, link.id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "bug.link_status",
    entity: "bug_service_link",
    entityId: link.id,
    before: link.status,
    after: status,
    meta: { bugId, serviceId },
  });
  revalidatePath(String(formData.get("path") ?? "/reporting"));
  revalidatePath("/");
}

export async function addBugServiceLinkAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const bugId = String(formData.get("bug_id") ?? "");
  const serviceId = String(formData.get("service_id") ?? "");
  if (!bugId || !serviceId) return;
  const existing = get<any>(
    `SELECT id FROM bug_service_links WHERE bug_id = ? AND service_id = ?`,
    bugId,
    serviceId
  );
  if (existing) {
    revalidatePath("/reporting");
    return;
  }
  run(
    `INSERT INTO bug_service_links (id, bug_id, service_id, status) VALUES (?, ?, ?, 'Open')`,
    uid("bsl"),
    bugId,
    serviceId
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "bug.link_add",
    entity: "bug_service_link",
    meta: { bugId, serviceId },
  });
  revalidatePath("/reporting");
  revalidatePath("/");
}

export async function saveProgressAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const activityId = String(formData.get("activity_id") ?? "");
  if (!activityId) return;
  const reported = Number(formData.get("reported") ?? 0) || 0;
  const fixed = Number(formData.get("fixed") ?? 0) || 0;
  const closed = Number(formData.get("closed") ?? 0) || 0;
  const outstanding = Number(formData.get("outstanding") ?? 0) || 0;
  const progress = parseInt(String(formData.get("progress_percent") ?? 0), 10) || 0;
  run(
    `INSERT INTO progress_snapshots (id, activity_id, as_of, reported, fixed, closed, outstanding, progress_percent, notes)
     VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, ?)`,
    uid("ps"),
    activityId,
    reported,
    fixed,
    closed,
    outstanding,
    progress,
    String(formData.get("notes") ?? "Manual report")
  );
  run(`UPDATE activities SET progress_percent = ?, updated_at = datetime('now') WHERE id = ?`, progress, activityId);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "progress.snapshot",
    entity: "activity",
    entityId: activityId,
    after: { reported, fixed, closed, outstanding, progress },
  });
  revalidatePath("/reporting");
  revalidatePath("/");
}
