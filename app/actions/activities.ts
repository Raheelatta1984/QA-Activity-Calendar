"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { inclusiveDays, isIsoDate } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";

export type ActionResult = { ok?: boolean; error?: string };

function optional(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function numberOf(formData: FormData, key: string, fallback: number | null): number | null {
  const value = optional(formData, key);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function saveActivityAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "You do not have permission to change activities." };

  const id = optional(formData, "id");
  const activity = optional(formData, "activity");
  if (!activity) return { error: "Activity name is required." };

  const plannedStart = optional(formData, "planned_start");
  const plannedEnd = optional(formData, "planned_end");
  const actualStart = optional(formData, "actual_start");
  const actualEnd = optional(formData, "actual_end");

  for (const [label, value] of [
    ["Planned start", plannedStart],
    ["Planned end", plannedEnd],
    ["Actual start", actualStart],
    ["Actual end", actualEnd],
  ] as const) {
    if (value && !isIsoDate(value)) return { error: `${label} must be a valid date (YYYY-MM-DD).` };
  }
  if (plannedStart && plannedEnd && plannedStart > plannedEnd) {
    return { error: "Planned start cannot be after planned end — dates are inclusive." };
  }
  if (actualStart && actualEnd && actualStart > actualEnd) {
    return { error: "Actual start cannot be after actual end." };
  }

  const startDate = plannedStart;
  const endDate = plannedEnd;
  const duration = startDate && endDate ? inclusiveDays(startDate, endDate) : null;

  const group = optional(formData, "activity_group") ?? "QA";
  const fteInput = numberOf(formData, "fte", null);
  const fteOverride = numberOf(formData, "fte_override", null);
  const defaultFte = group === "Regression" ? 1 : 0.5;
  const fte = fteInput !== null && fteInput > 0 ? fteInput : defaultFte;

  const progress = Math.max(0, Math.min(100, numberOf(formData, "progress_percent", 0) ?? 0));
  const active = formData.get("active") === "on" || formData.get("active") === "1" ? 1 : 0;

  const payload = {
    code: optional(formData, "code"),
    department_id: optional(formData, "department_id"),
    activity,
    detail: optional(formData, "detail"),
    activity_group: group,
    rule_type: optional(formData, "rule_type"),
    active,
    start_date: startDate,
    end_date: endDate,
    duration_days: duration,
    fte,
    fte_override: fteOverride,
    colour: optional(formData, "colour") ?? "#4f8cff",
    assignee_id: optional(formData, "assignee_id"),
    status: optional(formData, "status") ?? "Planned",
    notes: optional(formData, "notes"),
    planned_start: plannedStart,
    planned_end: plannedEnd,
    actual_start: actualStart,
    actual_end: actualEnd,
    progress_percent: progress,
    priority: optional(formData, "priority") ?? "Normal",
  };

  const path = String(formData.get("path") ?? "/calendar");

  try {
    if (id) {
      const before = get<any>("SELECT * FROM activities WHERE id = ?", id);
      if (!before) return { error: "Activity no longer exists." };
      run(
        `UPDATE activities SET code = ?, department_id = ?, activity = ?, detail = ?, activity_group = ?, rule_type = ?,
           active = ?, start_date = ?, end_date = ?, duration_days = ?, fte = ?, fte_override = ?, colour = ?,
           assignee_id = ?, status = ?, notes = ?, planned_start = ?, planned_end = ?, actual_start = ?, actual_end = ?,
           progress_percent = ?, priority = ?, updated_at = datetime('now')
         WHERE id = ?`,
        payload.code,
        payload.department_id,
        payload.activity,
        payload.detail,
        payload.activity_group,
        payload.rule_type,
        payload.active,
        payload.start_date,
        payload.end_date,
        payload.duration_days,
        payload.fte,
        payload.fte_override,
        payload.colour,
        payload.assignee_id,
        payload.status,
        payload.notes,
        payload.planned_start,
        payload.planned_end,
        payload.actual_start,
        payload.actual_end,
        payload.progress_percent,
        payload.priority,
        id
      );
      recordAudit({
        actorId: viewer.person.id,
        actorName: viewer.person.name,
        action: "activity.update",
        entity: "activity",
        entityId: id,
        before: { activity: before.activity, start: before.start_date, end: before.end_date, fte: before.fte },
        after: { activity: payload.activity, start: payload.start_date, end: payload.end_date, fte: payload.fte },
      });
    } else {
      const newId = uid("act");
      const nextSeq =
        (get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")?.n ?? 1) + 1001;
      run(
        `INSERT INTO activities
          (id, code, department_id, activity, detail, activity_group, rule_type, active, start_date, end_date, duration_days,
           fte, fte_override, colour, assignee_id, status, notes, calendar_item_id, planned_start, planned_end,
           actual_start, actual_end, progress_percent, priority, source_sheet, source_row, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', NULL, datetime('now'), datetime('now'))`,
        newId,
        payload.code ?? `CI-${nextSeq}`,
        payload.department_id,
        payload.activity,
        payload.detail,
        payload.activity_group,
        payload.rule_type,
        payload.active,
        payload.start_date,
        payload.end_date,
        payload.duration_days,
        payload.fte,
        payload.fte_override,
        payload.colour,
        payload.assignee_id,
        payload.status,
        payload.notes,
        payload.code ?? `CI-${nextSeq}`,
        payload.planned_start,
        payload.planned_end,
        payload.actual_start,
        payload.actual_end,
        payload.progress_percent,
        payload.priority
      );
      recordAudit({
        actorId: viewer.person.id,
        actorName: viewer.person.name,
        action: "activity.create",
        entity: "activity",
        entityId: newId,
        after: payload,
      });
    }
    revalidatePath(path);
    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function deleteActivityAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const before = get<any>("SELECT * FROM activities WHERE id = ?", id);
  if (!before) return;
  run("DELETE FROM activities WHERE id = ?", id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "activity.delete",
    entity: "activity",
    entityId: id,
    before,
  });
  revalidatePath(String(formData.get("path") ?? "/calendar"));
  revalidatePath("/");
}

export async function recordActualAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const activity = get<any>("SELECT * FROM activities WHERE id = ?", id);
  if (!activity) return;
  const today = String(formData.get("date") ?? "");
  const which = String(formData.get("which") ?? "start");
  if (which === "start") {
    run(
      `UPDATE activities SET actual_start = COALESCE(actual_start, ?), status = CASE WHEN status = 'Planned' THEN 'In Progress' ELSE status END, updated_at = datetime('now') WHERE id = ?`,
      today,
      id
    );
  } else {
    run(
      `UPDATE activities SET actual_end = ?, status = 'Complete', progress_percent = 100, updated_at = datetime('now') WHERE id = ?`,
      today,
      id
    );
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: which === "start" ? "activity.actual_start" : "activity.actual_end",
    entity: "activity",
    entityId: id,
    meta: { date: today, activity: activity.activity },
  });
  revalidatePath(String(formData.get("path") ?? "/calendar"));
  revalidatePath("/");
}

export async function updateProgressAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const progress = Math.max(0, Math.min(100, Number(formData.get("progress") ?? 0)));
  const status = String(formData.get("status") ?? "");
  run(
    `UPDATE activities SET progress_percent = ?, status = COALESCE(NULLIF(?, ''), status), updated_at = datetime('now') WHERE id = ?`,
    progress,
    status,
    id
  );
  if (formData.get("snapshot") === "1") {
    run(
      `INSERT INTO progress_snapshots (id, activity_id, as_of, reported, fixed, closed, outstanding, progress_percent, notes)
       VALUES (?, ?, date('now'), ?, ?, ?, ?, ?, 'Manual snapshot')`,
      uid("ps"),
      id,
      Number(formData.get("reported") ?? 0),
      Number(formData.get("fixed") ?? 0),
      Number(formData.get("closed") ?? 0),
      Number(formData.get("outstanding") ?? 0),
      progress
    );
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "activity.progress",
    entity: "activity",
    entityId: id,
    after: { progress, status },
  });
  revalidatePath(String(formData.get("path") ?? "/calendar"));
  revalidatePath("/");
}

export async function toggleActivityActiveAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const before = get<any>("SELECT active, activity FROM activities WHERE id = ?", id);
  if (!before) return;
  run(`UPDATE activities SET active = 1 - active, updated_at = datetime('now') WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "activity.toggle_active",
    entity: "activity",
    entityId: id,
    before: before.active,
    after: before.active ? 0 : 1,
  });
  revalidatePath(String(formData.get("path") ?? "/calendar"));
  revalidatePath("/");
}
