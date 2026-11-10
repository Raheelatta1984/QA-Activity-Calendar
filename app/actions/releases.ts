"use server";

import { revalidatePath } from "next/cache";
import { all, get, run, transaction } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { isIsoDate } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";
import { assignablePeople, syncReleaseAssignees } from "@/lib/releases";

function field(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (raw === null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

export async function saveReleaseFeedAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const version = field(formData, "version");
  if (!version) return;
  const date = field(formData, "date");
  if (date && !isIsoDate(date)) return;
  const id = field(formData, "id");
  const payload = {
    version,
    kind: field(formData, "kind") ?? "Self Update",
    date,
    notes: field(formData, "notes"),
    link: field(formData, "link"),
    department_id: field(formData, "department_id"),
  };
  if (id) {
    const before = get<any>("SELECT * FROM release_feed WHERE id = ?", id);
    run(
      `UPDATE release_feed SET version = ?, kind = ?, date = ?, notes = ?, link = ?, department_id = ?, link_verified = 0 WHERE id = ?`,
      payload.version,
      payload.kind,
      payload.date,
      payload.notes,
      payload.link,
      payload.department_id,
      id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "release.update",
      entity: "release_feed",
      entityId: id,
      before,
      after: payload,
    });
  } else {
    const newId = uid("rf");
    run(
      `INSERT INTO release_feed (id, version, kind, date, notes, link, department_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId,
      payload.version,
      payload.kind,
      payload.date,
      payload.notes,
      payload.link,
      payload.department_id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "release.create",
      entity: "release_feed",
      entityId: newId,
      after: payload,
    });
  }
  revalidatePath("/releases");
  revalidatePath("/");
}

export async function verifyReleaseLinkAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  run(`UPDATE release_feed SET link_verified = 1 WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "release.link_verified",
    entity: "release_feed",
    entityId: id,
  });
  revalidatePath("/releases");
}

export async function savePquAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const train = field(formData, "train");
  if (!train) return;
  const cutoff = field(formData, "change_cutoff");
  if (cutoff && !isIsoDate(cutoff)) return;
  const duration = Number(formData.get("duration_days") ?? 0) || null;

  // Flag rather than silently correct suspicious chronology.
  const flags: string[] = [];
  if (cutoff && duration && duration > 30) flags.push("Duration exceeds 30 days — confirm train length.");
  if (cutoff && cutoff < new Date().toISOString().slice(0, 10) && field(formData, "status") === "Planned") {
    flags.push("Cutoff is in the past but status is Planned.");
  }

  const id = field(formData, "id");
  const payload = {
    train,
    change_cutoff: cutoff,
    duration_days: duration,
    status: field(formData, "status") ?? "Planned",
    app_version: field(formData, "app_version"),
    platform_version: field(formData, "platform_version"),
    date_text_raw: field(formData, "date_text_raw"),
    flag: flags.length ? flags.join(" ") : null,
  };
  if (id) {
    const before = get<any>("SELECT * FROM pqu_trains WHERE id = ?", id);
    run(
      `UPDATE pqu_trains SET train = ?, change_cutoff = ?, duration_days = ?, status = ?, app_version = ?, platform_version = ?, date_text_raw = ?, flag = ? WHERE id = ?`,
      payload.train,
      payload.change_cutoff,
      payload.duration_days,
      payload.status,
      payload.app_version,
      payload.platform_version,
      payload.date_text_raw,
      payload.flag,
      id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "pqu.update",
      entity: "pqu_train",
      entityId: id,
      before,
      after: payload,
    });
  } else {
    const newId = uid("pqu");
    run(
      `INSERT INTO pqu_trains (id, train, change_cutoff, duration_days, status, app_version, platform_version, date_text_raw, flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      payload.train,
      payload.change_cutoff,
      payload.duration_days,
      payload.status,
      payload.app_version,
      payload.platform_version,
      payload.date_text_raw,
      payload.flag
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "pqu.create",
      entity: "pqu_train",
      entityId: newId,
      after: payload,
    });
  }
  revalidatePath("/releases");
}

export type DecisionResult = { ok?: boolean; error?: string };

export async function saveDecisionAction(_prev: DecisionResult, formData: FormData): Promise<DecisionResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const version = field(formData, "version");
  if (!version) return { error: "A release version is required." };

  const regression = field(formData, "regression_status") ?? "Not started";
  const goNoGo = field(formData, "go_no_go") ?? "Pending";
  const deployment = field(formData, "deployment_status") ?? "Not deployed";
  const decidedAt = field(formData, "decided_at");

  if (goNoGo === "Go" && regression !== "Passed") {
    return {
      error: "A Go decision requires regression status Passed. Planned status is never treated as approval.",
    };
  }
  if (goNoGo === "No-Go" && deployment === "Deployed") {
    return { error: "A No-Go release cannot be marked Deployed." };
  }

  const id = uid("gov");
  run(
    `INSERT INTO release_governance (id, release_id, version, regression_status, go_no_go, deployment_status, decided_by, decided_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `REL-${version}`,
    version,
    regression,
    goNoGo,
    deployment,
    goNoGo === "Pending" ? null : viewer.person.id,
    goNoGo === "Pending" ? null : decidedAt || new Date().toISOString().slice(0, 10),
    field(formData, "notes")
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "governance.decision",
    entity: "release_governance",
    entityId: id,
    after: { version, regression, goNoGo, deployment },
  });
  revalidatePath("/releases");
  revalidatePath("/");
  return { ok: true };
}

export async function deleteReleaseFeedAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  run(`DELETE FROM release_feed WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "release.delete",
    entity: "release_feed",
    entityId: id,
  });
  revalidatePath("/releases");
}

/**
 * Release planning: the QA window and the people doing the work.
 *
 * This is the single write path for release effort. Everything downstream
 * (Releases FTE columns, the QA calendar bar, the FTE calendar rows) is derived
 * from these two fields plus the assignee shares, so the three tabs can never
 * disagree. A window without assignees is saved deliberately — the gap is shown
 * as "effort unknown", never silently counted as zero.
 */
export type ReleasePlanResult = { ok?: boolean; error?: string; message?: string };

export async function saveReleasePlanAction(
  _prev: ReleasePlanResult,
  formData: FormData
): Promise<ReleasePlanResult> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const id = field(formData, "id");
  if (!id) return { error: "Missing release reference." };
  const release = get<{ id: string; version: string }>(
    `SELECT id, version FROM release_feed WHERE id = ?`,
    id
  );
  if (!release) return { error: "That release no longer exists." };

  const from = field(formData, "qa_start_date");
  const to = field(formData, "qa_end_date");
  if (from && !isIsoDate(from)) return { error: "QA start must be a real date (YYYY-MM-DD)." };
  if (to && !isIsoDate(to)) return { error: "QA end must be a real date (YYYY-MM-DD)." };
  if ((from && !to) || (!from && to)) return { error: "Enter both QA dates, or clear both — half a window cannot be resourced." };
  if (from && to && from > to) return { error: "The QA window ends before it starts. Dates are inclusive; fix the range." };

  // Only people in the viewer's scope may be assigned. Anyone the editor cannot
  // see keeps whatever assignment they already had (see syncReleaseAssignees).
  const assignable = assignablePeople(viewer);
  const selected: { person_id: string; fte: number }[] = [];
  for (const person of assignable) {
    if (formData.get(`person_${person.id}`) === null) continue;
    const raw = String(formData.get(`fte_${person.id}`) ?? "").trim();
    const fte = raw === "" ? 0.5 : Number(raw);
    if (!Number.isFinite(fte) || fte < 0 || fte > 5) {
      return { error: `${person.name}: FTE must be a number between 0 and 5.` };
    }
    if (fte === 0) {
      return { error: `${person.name}: an assignee needs an FTE above 0 — untick the person instead.` };
    }
    selected.push({ person_id: person.id, fte: Math.round(fte * 100) / 100 });
  }
  const inScope = new Set(assignable.map((person) => person.id));

  const before = get<any>(`SELECT * FROM release_feed WHERE id = ?`, id);
  const beforeAssignees = all<any>(`SELECT person_id, fte FROM release_assignees WHERE release_id = ?`, id);

  transaction(() => {
    run(`UPDATE release_feed SET qa_start_date = ?, qa_end_date = ? WHERE id = ?`, from, to, id);
    syncReleaseAssignees(id, inScope, selected);
  });

  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "release.plan",
    entity: "release_feed",
    entityId: id,
    before: { ...before, assignees: beforeAssignees },
    after: { qa_start_date: from, qa_end_date: to, assignees: selected },
  });

  revalidatePath("/releases");
  revalidatePath("/calendar");
  revalidatePath("/fte");
  revalidatePath("/");
  return {
    ok: true,
    message: `${release.version}: QA window ${from && to ? `${from} → ${to}` : "cleared"} · ${selected.length} assignee${
      selected.length === 1 ? "" : "s"
    }. The QA and FTE calendars were updated.`,
  };
}
