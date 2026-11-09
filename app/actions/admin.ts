"use server";

import { revalidatePath } from "next/cache";
import { all, get, run, setSetting } from "@/lib/db";
import { canAdmin, canManagePeople, getViewer, loadOrg, descendantsOf, scopedDepartmentId } from "@/lib/access";
import { setDefaultCompany } from "@/lib/org";
import { hashPassword } from "@/lib/auth";
import { uid } from "@/lib/ids";
import { isIsoDate, isoToday } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";

export type AdminResult = { ok?: boolean; error?: string };

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidateAll() {
  revalidatePath("/setup");
  revalidatePath("/", "layout");
  revalidatePath("/");
}

export async function saveCompanyAction(_prev: AdminResult, formData: FormData): Promise<AdminResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an administrator can change the company entity." };
  const name = value(formData, "name");
  if (!name) return { error: "Company name is required." };
  const fiscal = Number(formData.get("fiscal_start_month") ?? 7);
  if (fiscal < 1 || fiscal > 12) return { error: "Fiscal start month must be 1–12." };
  const before = get<any>("SELECT * FROM companies WHERE id = ?", viewer.org.company.id);
  run(
    `UPDATE companies SET name = ?, legal_name = ?, timezone = ?, fiscal_start_month = ? WHERE id = ?`,
    name,
    value(formData, "legal_name") || null,
    value(formData, "timezone") || "Australia/Sydney",
    fiscal,
    viewer.org.company.id
  );
  setSetting("fiscal.start_month", String(fiscal));
  setSetting("app.timezone", value(formData, "timezone") || "Australia/Sydney");
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "company.update",
    entity: "company",
    entityId: viewer.org.company.id,
    before,
    after: { name, fiscal },
  });
  revalidateAll();
  return { ok: true };
}

export async function saveDepartmentAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  const name = value(formData, "name");
  const code = value(formData, "code").toUpperCase() || name.slice(0, 4).toUpperCase();
  if (!name) return;
  if (id) {
    run(
      `UPDATE departments SET name = ?, code = ?, description = ?, colour = ? WHERE id = ?`,
      name,
      code,
      value(formData, "description") || null,
      value(formData, "colour") || "#4f8cff",
      id
    );
  } else {
    const newId = uid("dept");
    run(
      `INSERT INTO departments (id, company_id, code, name, description, colour, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM departments))`,
      newId,
      viewer.org.company.id,
      code,
      name,
      value(formData, "description") || null,
      value(formData, "colour") || "#4f8cff"
    );
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: id ? "department.update" : "department.create",
    entity: "department",
    entityId: id || null,
    after: { name, code },
  });
  revalidateAll();
}

/** Make `id` the default company (drives loadOrg + the login scope). Admin-only, audited. */
export async function setDefaultCompanyAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  if (!id) return;
  const target = get<{ id: string; name: string }>("SELECT id, name FROM companies WHERE id = ?", id);
  if (!target) return;
  if (viewer.org.company.id === id && viewer.org.company.is_default) return; // already default
  const before = get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_company_id'")?.value ?? null;
  try {
    setDefaultCompany(id);
  } catch {
    return;
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "company.set_default",
    entity: "company",
    entityId: id,
    before: { default_company_id: before },
    after: { default_company_id: id },
    meta: { name: target.name },
  });
  revalidateAll();
}

export async function toggleDepartmentAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  const before = get<any>("SELECT * FROM departments WHERE id = ?", id);
  if (!before) return;
  run(`UPDATE departments SET enabled = 1 - enabled WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "department.toggle",
    entity: "department",
    entityId: id,
    before: before.enabled,
    after: before.enabled ? 0 : 1,
  });
  revalidateAll();
}

export async function savePersonAction(_prev: AdminResult, formData: FormData): Promise<AdminResult> {
  const viewer = await getViewer();
  if (!canManagePeople(viewer)) return { error: "You do not have permission to manage people." };

  const id = value(formData, "id");
  const name = value(formData, "name");
  const email = value(formData, "email").toLowerCase();
  const role = value(formData, "role") || "viewer";
  if (!name) return { error: "Name is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid email is required." };
  if (role === "admin" && viewer.role !== "admin") return { error: "Only an administrator can grant admin." };

  const duplicate = get<{ id: string }>(`SELECT id FROM people WHERE LOWER(email) = ? AND id <> ?`, email, id);
  if (duplicate) return { error: "That email is already in use." };

  let managerId = value(formData, "manager_id") || null;
  if (managerId === id) return { error: "A person cannot report to themselves." };

  const org = loadOrg();
  if (id && managerId) {
    const subtree = descendantsOf(org.people, id);
    if (subtree.has(managerId)) return { error: "That move would create a reporting loop." };
  }
  // Managers may only edit their own sub-tree and cannot promote above their role.
  if (viewer.role === "manager") {
    const scope = descendantsOf(org.people, viewer.person.id);
    if (id && !scope.has(id)) return { error: "You can only edit your own team." };
    if (managerId && !scope.has(managerId)) return { error: "The manager must be inside your team." };
  }
  const capacity = Number(formData.get("capacity_hours_day") ?? 7.6) || 7.6;
  const departmentId = value(formData, "department_id") || null;
  // Department-scoped admins (DEPARTMENT_ADMIN) manage only their own department.
  if (viewer.role === "department_admin") {
    const scope = scopedDepartmentId(viewer.person);
    if (!scope) return { error: "This department administrator account is not linked to a department." };
    if (id) {
      const beforePerson = get<{ department_id: string | null }>(`SELECT department_id FROM people WHERE id = ?`, id);
      if (!beforePerson) return { error: "Person no longer exists." };
      if (beforePerson.department_id !== scope) return { error: "You can only manage people in your own department." };
    }
    if (!id && !departmentId) return { error: "Choose your department when adding a person." };
    if (departmentId && departmentId !== scope) {
      return { error: "You can only assign people to your own department." };
    }
    if (managerId) {
      const mgr = get<{ department_id: string | null }>(`SELECT department_id FROM people WHERE id = ?`, managerId);
      if (mgr && mgr.department_id !== scope) return { error: "The manager must be inside your department." };
    }
  }
  if (role === "department_admin" && viewer.role !== "admin") {
    return { error: "Only an application administrator can grant department-level administration." };
  }
  const active = formData.get("active") === "on" || formData.get("active") === "1" ? 1 : 0;
  const password = value(formData, "password");

  if (id) {
    const before = get<any>("SELECT * FROM people WHERE id = ?", id);
    if (!before) return { error: "Person no longer exists." };
    run(
      `UPDATE people SET name = ?, email = ?, title = ?, role = ?, manager_id = ?, department_id = ?,
         capacity_hours_day = ?, active = ? WHERE id = ?`,
      name,
      email,
      value(formData, "title") || null,
      role,
      managerId,
      departmentId,
      capacity,
      active,
      id
    );
    if (password) {
      run(`UPDATE people SET password_hash = ? WHERE id = ?`, hashPassword(password), id);
    }
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "person.update",
      entity: "person",
      entityId: id,
      before: { name: before.name, role: before.role, manager: before.manager_id },
      after: { name, role, manager: managerId },
    });
  } else {
    const newId = uid("p");
    run(
      `INSERT INTO people (id, department_id, manager_id, name, email, title, role, password_hash, capacity_hours_day, active, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      newId,
      departmentId,
      managerId,
      name,
      email,
      value(formData, "title") || null,
      role,
      hashPassword(password || "demo1234"),
      capacity,
      active
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "person.create",
      entity: "person",
      entityId: newId,
      after: { name, email, role },
    });
  }
  revalidateAll();
  return { ok: true };
}

export async function movePersonAction(personId: string, managerId: string | null): Promise<AdminResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an administrator can restructure the hierarchy." };
  if (personId === managerId) return { error: "A person cannot report to themselves." };
  const org = loadOrg();
  if (managerId && descendantsOf(org.people, personId).has(managerId)) {
    return { error: "That move would create a reporting loop." };
  }
  const before = get<any>("SELECT manager_id, name FROM people WHERE id = ?", personId);
  if (!before) return { error: "Person not found." };
  run(`UPDATE people SET manager_id = ? WHERE id = ?`, managerId, personId);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "person.move",
    entity: "person",
    entityId: personId,
    before: before.manager_id,
    after: managerId,
    meta: { person: before.name },
  });
  revalidateAll();
  return { ok: true };
}

export async function togglePersonActiveAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canManagePeople(viewer)) return;
  const id = value(formData, "id");
  run(`UPDATE people SET active = 1 - active WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "person.toggle_active",
    entity: "person",
    entityId: id,
  });
  revalidateAll();
}

export async function toggleTabAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  const before = get<any>("SELECT enabled, label FROM tabs WHERE id = ?", id);
  if (!before) return;
  run(`UPDATE tabs SET enabled = 1 - enabled WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "tab.toggle",
    entity: "tab",
    entityId: id,
    before: before.enabled,
    after: before.enabled ? 0 : 1,
  });
  revalidateAll();
}

export async function toggleSectionAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  run(`UPDATE sections SET enabled = 1 - enabled WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "section.toggle",
    entity: "section",
    entityId: id,
  });
  revalidateAll();
}

export async function saveHolidayAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const date = value(formData, "date");
  const name = value(formData, "name");
  if (!isIsoDate(date) || !name) return;
  run(
    `INSERT OR IGNORE INTO holidays (id, date, name, jurisdiction, year, source) VALUES (?, ?, ?, 'NSW', ?, 'manual')`,
    uid("hol"),
    date,
    name,
    Number(date.slice(0, 4))
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "holiday.create",
    entity: "holiday",
    meta: { date, name },
  });
  revalidateAll();
}

export async function deleteHolidayAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const id = value(formData, "id");
  run(`DELETE FROM holidays WHERE id = ?`, id);
  revalidateAll();
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const keys = [
    "fte.regression_value",
    "fte.default_value",
    "fte.hours_per_day",
    "capacity.include_unavailable",
    "app.name",
  ];
  for (const key of keys) {
    const raw = formData.get(key);
    if (raw === null) continue;
    setSetting(key, String(raw));
  }
  if (formData.get("capacity.include_unavailable") === null) {
    setSetting("capacity.include_unavailable", "false");
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "settings.update",
    entity: "settings",
    meta: Object.fromEntries(keys.map((k) => [k, String(formData.get(k) ?? "")])),
  });
  revalidateAll();
}

export async function backfillValidationAction(): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const rows = all<any>(`SELECT id FROM activities WHERE start_date IS NULL AND active = 1`);
  for (const row of rows) {
    run(`UPDATE activities SET data_quality = 'Unscheduled — missing dates' WHERE id = ?`, row.id);
  }
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "activity.backfill_quality",
    entity: "activity",
    meta: { rows: rows.length, at: isoToday() },
  });
  revalidateAll();
}
