"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canAdmin, canEdit, departmentInCompany, getViewer, personInCompany, tenantId } from "@/lib/access";
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

  const automationRaw = String(formData.get("automation_percent") ?? "").trim();
  // Blank automation stays NULL — never silently zero-filled (import fidelity).
  const automation = automationRaw === "" ? null : Math.max(0, Math.min(100, Number(automationRaw) || 0));
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
    automation_fraction: automation === null ? null : automation / 100,
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
  const companyId = tenantId(viewer);
  if (payload.department_id && !departmentInCompany(viewer, payload.department_id)) {
    return { error: "That department is outside this tenant." };
  }
  if (payload.assignee_id && !personInCompany(viewer, payload.assignee_id)) {
    return { error: "That assignee is outside this tenant." };
  }

  if (id) {
    const before = get<any>("SELECT * FROM recording_pipeline WHERE id = ?", id);
    if (!before) return { error: "Recording no longer exists." };
    if (before.company_id && before.company_id !== companyId) {
      return { error: "That recording belongs to another company." };
    }
    run(
      `UPDATE recording_pipeline SET code = ?, department_id = ?, activity = ?, detail = ?, planned_start = ?, planned_end = ?,
         actual_start = ?, actual_end = ?, duration_days = ?, recording_status = COALESCE(?, recording_status), current_status = ?, automation_percent = ?, automation_fraction = ?,
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
      text(formData, "recording_status"),
      payload.current_status,
      payload.automation_percent,
      payload.automation_fraction,
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
    const seq =
      (get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?",
        companyId
      )?.n ?? 0) + 201;
    run(
      `INSERT INTO recording_pipeline
        (id, company_id, code, department_id, activity, detail, planned_start, planned_end, actual_start, actual_end, duration_days,
         recording_status, current_status, automation_percent, automation_fraction, blocker, colour, assignee_id, is_test, notes, source_sheet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'app')`,
      newId,
      companyId,
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
      payload.automation_fraction,
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
  if (!before || (before.company_id && before.company_id !== tenantId(viewer))) return;
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
  const companyId = tenantId(viewer);
  if (pipelineId) {
    const pipeline = get<{ company_id: string | null }>(
      `SELECT company_id FROM recording_pipeline WHERE id = ?`,
      pipelineId
    );
    if (!pipeline || (pipeline.company_id && pipeline.company_id !== companyId)) return;
  }
  const id = uid("exc");
  run(
    `INSERT INTO pipeline_exclusions (id, company_id, pipeline_id, date, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    companyId,
    pipelineId,
    date,
    reason,
    viewer.actingAs.id
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
  if (!before || (before.company_id && before.company_id !== tenantId(viewer))) return;
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

/** Owner review action: confirm a TEST-labelled imported pipeline row as operational.
 *  Reserved for application administrators — never granted by import itself. */
export async function confirmPipelineVerificationAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const before = get<any>(`SELECT * FROM recording_pipeline WHERE id = ?`, id);
  if (!before || (before.company_id && before.company_id !== tenantId(viewer))) return;
  if (before.verification_status === "Confirmed operational") return;
  run(`UPDATE recording_pipeline SET verification_status = 'Confirmed operational' WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "pipeline.verification_confirmed",
    entity: "recording_pipeline",
    entityId: id,
    before: { verification_status: before.verification_status ?? null, is_test: before.is_test },
    after: { verification_status: "Confirmed operational" },
    meta: { external_source_id: before.external_source_id ?? null, note: "Owner confirmed a TEST-labelled source record as operational" },
  });
  revalidatePath(String(formData.get("path") ?? "/pipeline"));
  revalidatePath("/");
}

export async function updateRecordingAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const automationRaw = String(formData.get("automation_percent") ?? "").trim();
  // Blank automation stays NULL — never silently zero-filled (import fidelity).
  const automation = automationRaw === "" ? null : Math.max(0, Math.min(100, Number(automationRaw) || 0));
  const status = String(formData.get("recording_status") ?? "");
  const target = get<{ company_id: string | null }>("SELECT company_id FROM recording_pipeline WHERE id = ?", id);
  if (!target || (target.company_id && target.company_id !== tenantId(viewer))) return;
  run(
    `UPDATE recording_pipeline SET automation_percent = ?, automation_fraction = ?, recording_status = COALESCE(NULLIF(?, ''), recording_status) WHERE id = ?`,
    automation,
    automation === null ? null : automation / 100,
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
