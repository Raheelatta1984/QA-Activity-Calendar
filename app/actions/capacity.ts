"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canEdit, getViewer, personInCompany } from "@/lib/access";
import { uid } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";
import { isIsoDate } from "@/lib/dates";

export async function saveCapacityAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const personId = String(formData.get("person_id") ?? "");
  const date = String(formData.get("date") ?? "");
  if (!personId || !isIsoDate(date)) return;
  if (!personInCompany(viewer, personId)) return;

  const notAvailable = Math.max(0, Number(formData.get("not_available_hours") ?? 0) || 0);
  const devops = Math.max(0, Number(formData.get("devops_hours") ?? 0) || 0);
  const recording = Math.max(0, Number(formData.get("recording_hours") ?? 0) || 0);
  const qa = Math.max(0, Number(formData.get("qa_testing_hours") ?? 0) || 0);
  const totalInput = Number(formData.get("total_hours") ?? 0);
  const total = totalInput > 0 ? totalInput : 7.6;
  const note = String(formData.get("note") ?? "").trim() || null;

  const existing = get<any>(
    `SELECT * FROM resource_day_capacity WHERE person_id = ? AND date = ?`,
    personId,
    date
  );
  if (existing) {
    run(
      `UPDATE resource_day_capacity SET not_available_hours = ?, devops_hours = ?, recording_hours = ?,
         qa_testing_hours = ?, total_hours = ?, note = ?, source = 'manual' WHERE id = ?`,
      notAvailable,
      devops,
      recording,
      qa,
      total,
      note,
      existing.id
    );
  } else {
    run(
      `INSERT INTO resource_day_capacity (id, person_id, date, not_available_hours, devops_hours, recording_hours, qa_testing_hours, total_hours, note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      uid("cap"),
      personId,
      date,
      notAvailable,
      devops,
      recording,
      qa,
      total,
      note
    );
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "capacity.update",
    entity: "resource_day_capacity",
    entityId: existing?.id ?? null,
    before: existing ? { total: existing.total_hours, qa: existing.qa_testing_hours } : undefined,
    after: { date, total, qa, notAvailable, devops, recording },
  });
  revalidatePath(String(formData.get("path") ?? "/capacity"));
  revalidatePath("/");
}

export async function bulkCapacityAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const monthKey = String(formData.get("month") ?? "");
  const total = Number(formData.get("total_hours") ?? 7.6);
  const personId = String(formData.get("person_id") ?? "");
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
  if (personId && !personInCompany(viewer, personId)) return;

  const people = personId
    ? [{ id: personId }]
    : viewer.org.people
        .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
        .filter((p) => viewer.departmentIds.has(p.department_id ?? ""));

  const days = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)).getUTCDate();
  let updated = 0;
  for (const person of people) {
    for (let day = 1; day <= days; day += 1) {
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const existing = get<any>(
        `SELECT id, total_hours, qa_testing_hours FROM resource_day_capacity WHERE person_id = ? AND date = ?`,
        person.id,
        date
      );
      if (existing) {
        run(`UPDATE resource_day_capacity SET total_hours = ? WHERE id = ?`, total, existing.id);
      } else {
        run(
          `INSERT INTO resource_day_capacity (id, person_id, date, total_hours, qa_testing_hours, source)
           VALUES (?, ?, ?, ?, ?, 'bulk')`,
          uid("cap"),
          person.id,
          date,
          total,
          total
        );
      }
      updated += 1;
    }
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "capacity.bulk_default",
    entity: "resource_day_capacity",
    meta: { monthKey, total, people: people.length, updated },
  });
  revalidatePath(String(formData.get("path") ?? "/capacity"));
  revalidatePath("/");
}
