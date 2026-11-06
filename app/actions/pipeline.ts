"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { inclusiveDays, isIsoDate } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";

export type PipelineResult = { ok?: boolean; error?: string };

function text(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (raw === null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

export async function savePipelineAction(_prev: PipelineResult, formData: FormData): Promise<PipelineResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const id = text(formData, "id");
  const activity = text(formData, "activity");
  if (!activity) return { error: "Recording name is required." };

  const plannedStart = text(formData, "planned_start");
  const plannedEnd = text(formData, "planned_end");
  const actualStart = text(formData, "actual_start");
  const actualEnd = text(formData, "actual_end");
  for (const value of [plannedStart, plannedEnd, actualStart, actualEnd]) {
    if (value && !isIsoDate(value)) return { error: "Dates must be valid (YYYY-MM-DD)." };
  }
  if (plannedStart && plannedEnd && plannedStart > plannedEnd) {
    return { error: "Planned start cannot be after planned end." };
  }
  if (actualStart && actualEnd && actualStart > actualEnd) {
    return { error: "Actual start cannot be after actual end." };
  }

  const automation = Math.max(0, Math.min(100, Number(formData.get("automation_percent") ?? 0) || 0));
  const payload = {
    code: text(formData, "code"),
    department_id: text(formData, "department_id"),
    activity,
    detail: text(formData, "detail"),
    planned_start: plannedStart,
    planned_end: plannedEnd,
    actual_start: actualStart,
    actual_end: actualEnd,
    duration_days: plannedStart && plannedEnd ? inclusiveDays(plannedStart, plannedEnd) : null,
    recording_status: text(formData, "recording_status") ?? "Not started",
    current_status: text(formData, "current_status") ?? "Pending",
    automation_percent: automation,
    blocker: text(formData, "blocker"),
    colour: text(formData, "colour") ?? "#8b5cf6",
    assignee_id: text(formData, "assignee_id"),
    is_test: formData.get("is_test") === "on" || formData.get("is_test") === "1" ? 1 : 0,
    notes: text(formData, "notes"),
  };

  if (payload.current_status === "Blocked" && !payload.blocker) {
    return { error: "A blocked recording needs a blocker reason." };
  }

  const path = String(formData.get("path") ?? "/pipeline");

  if (id) {
    const before = get<any>("SELECT * FROM recording_pipeline WHERE id = ?", id);
    if (!before) return { error: "Recording no longer exists." };
    run(
      `UPDATE recording_pipeline SET code = ?, department_id = ?, activity = ?, detail = ?, planned_start = ?, planned_end = ?,
         actual_start = ?, actual_end = ?, duration_days = ?, recording_status = ?, current_status = ?, automation_percent = ?,
         blocker = ?, colour = ?, assignee_id = ?, is_test = ?, notes = ? WHERE id = ?`,
      payload.code,
      payload.department_id,
      payload.activity,
      payload.detail,
      payload.planned_start,
      payload.planned_end,
      payload.actual_start,
      payload.actual_end,
      payload.duration_days,
      payload.recording_status,
      payload.current_status,
      payload.automation_percent,
      payload.blocker,
      payload.colour,
      payload.assignee_id,
      payload.is_test,
      payload.notes,
      id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "pipeline.update",
      entity: "recording_pipeline",
      entityId: id,
      before,
      after: payload,
    });
  } else {
    const newId = uid("pipe");
    const seq = (get<{ n: number }>("SELECT COUNT(*) AS n FROM recording_pipeline")?.n ?? 0) + 201;
    run(
      `INSERT INTO recording_pipeline
        (id, code, department_id, activity, detail, planned_start, planned_end, actual_start, actual_end, duration_days,
         recording_status, current_status, automation_percent, blocker, colour, assignee_id, is_test, notes, source_sheet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app')`,
      newId,
      payload.code ?? `REC-${seq}`,
      payload.department_id,
      payload.activity,
      payload.detail,
      payload.planned_start,
      payload.planned_end,
      payload.actual_start,
      payload.actual_end,
      payload.duration_days,
      payload.recording_status,
      payload.current_status,
      payload.automation_percent,
      payload.blocker,
      payload.colour,
      payload.assignee_id,
      payload.is_test,
      payload.notes
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "pipeline.create",
      entity: "recording_pipeline",
      entityId: newId,
      after: payload,
    });
  }
  revalidatePath(path);
  revalidatePath("/");
  return { ok: true };
}

export async function deletePipelineAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const before = get<any>("SELECT * FROM recording_pipeline WHERE id = ?", id);
  if (!before) return;
  run(`DELETE FROM recording_pipeline WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "pipeline.delete",
    entity: "recording_pipeline",
    entityId: id,
    before,
  });
  revalidatePath(String(formData.get("path") ?? "/pipeline"));
  revalidatePath("/");
}

export async function addExclusionAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const date = String(formData.get("date") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const pipelineId = String(formData.get("pipeline_id") ?? "") || null;
  if (!isIsoDate(date) || !reason) return;
  const id = uid("exc");
  run(
    `INSERT INTO pipeline_exclusions (id, pipeline_id, date, reason, created_by) VALUES (?, ?, ?, ?, ?)`,
    id,
    pipelineId,
    date,
    reason,
    viewer.person.id
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "pipeline.exclusion_create",
    entity: "pipeline_exclusion",
    entityId: id,
    after: { date, reason, pipelineId },
  });
  revalidatePath("/pipeline");
  revalidatePath("/");
}

export async function removeExclusionAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const before = get<any>("SELECT * FROM pipeline_exclusions WHERE id = ?", id);
  if (!before) return;
  run(`DELETE FROM pipeline_exclusions WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "pipeline.exclusion_delete",
    entity: "pipeline_exclusion",
    entityId: id,
    before,
  });
  revalidatePath("/pipeline");
  revalidatePath("/");
}

export async function updateRecordingAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const automation = Math.max(0, Math.min(100, Number(formData.get("automation_percent") ?? 0) || 0));
  const status = String(formData.get("recording_status") ?? "");
  run(
    `UPDATE recording_pipeline SET automation_percent = ?, recording_status = COALESCE(NULLIF(?, ''), recording_status) WHERE id = ?`,
    automation,
    status,
    id
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "pipeline.progress",
    entity: "recording_pipeline",
    entityId: id,
    after: { automation, status },
  });
  revalidatePath(String(formData.get("path") ?? "/pipeline"));
}
