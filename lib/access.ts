import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { all, get } from "./db";
import { getSession, type Person } from "./auth";

export const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  department_admin: 4, // department-scoped administrator (HFM seed: DEPARTMENT_ADMIN)
  exec: 4,
  admin: 5, // whole-application administrator (HFM seed: APPLICATION_ADMIN)
};

export type Department = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  description: string | null;
  colour: string;
  enabled: number;
  sort_order: number;
};

export type Company = {
  id: string;
  name: string;
  legal_name: string | null;
  timezone: string;
  fiscal_start_month: number;
};

export type Org = {
  company: Company;
  departments: Department[];
  people: Person[];
  byId: Map<string, Person>;
  deptById: Map<string, Department>;
};

export type Viewer = {
  person: Person;
  actingAs: Person;
  previewing: boolean;
  role: string;
  org: Org;
  departmentIds: Set<string>;
  personIds: Set<string>;
  canSeeAll: boolean;
  readOnly: boolean;
  activeDepartmentId: string | null;
  enabledDepartments: Department[];
};

export function loadOrg(): Org {
  // Default company: the explicitly configured HFM default wins; otherwise
  // fall back to the oldest company (legacy behaviour). A default selection
  // never grants cross-company access — it only chooses which company's
  // departments render.
  const configuredDefault = get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_company_id'")?.value;
  const company =
    get<Company>("SELECT * FROM companies WHERE is_default = 1 LIMIT 1") ??
    (configuredDefault
      ? get<Company>("SELECT * FROM companies WHERE id = ?", configuredDefault)
      : undefined) ??
    get<Company>("SELECT * FROM companies ORDER BY created_at LIMIT 1") ?? {
      id: "co_default",
      name: "HFM",
      legal_name: null,
      timezone: "Australia/Sydney",
      fiscal_start_month: 7,
    };
  const departments = all<Department>("SELECT * FROM departments ORDER BY sort_order, name");
  const people = all<Person>("SELECT * FROM people ORDER BY name");
  return {
    company,
    departments,
    people,
    byId: new Map(people.map((p) => [p.id, p])),
    deptById: new Map(departments.map((d) => [d.id, d])),
  };
}

export function descendantsOf(people: Person[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const p of people) {
    if (!p.manager_id) continue;
    const list = children.get(p.manager_id) ?? [];
    list.push(p.id);
    children.set(p.manager_id, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  let guard = 0;
  while (stack.length && guard < 5000) {
    const current = stack.pop()!;
    for (const child of children.get(current) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
    guard += 1;
  }
  return out;
}

/**
 * A person may only see their own sub-tree — never their manager or anyone
 * further up the reporting line. Admin/exec roles get the holistic view.
 */
/** Department a department_admin is scoped to (NULL for every other role). */
export function scopedDepartmentId(person: Pick<Person, "role"> & { role_scope_department_id?: string | null }): string | null {
  return person.role === "department_admin" ? (person.role_scope_department_id ?? null) : null;
}

export function scopeFor(person: Person, org: Org) {
  const role = person.role;
  const isHolistic = role === "admin" || role === "exec";
  const scopedDept = scopedDepartmentId(person as any);
  // A department_admin sees their own department in full (they manage it);
  // every other role sees only their own sub-tree. Nothing reaches upward.
  const personIds =
    isHolistic
      ? new Set(org.people.map((p) => p.id))
      : role === "department_admin" && scopedDept
        ? new Set([...org.people.filter((p) => p.department_id === scopedDept).map((p) => p.id), person.id])
        : descendantsOf(org.people, person.id);
  // Disabled departments are excluded from operational views for everyone;
  // admins can still see them in Master Setup to re-enable.
  const departmentIds =
    role === "department_admin" && scopedDept
      ? new Set(org.departments.filter((d) => d.id === scopedDept && !!d.enabled).map((d) => d.id))
      : new Set(
          org.departments.filter((d) => !!d.enabled).map((d) => d.id)
        );
  return { role, isHolistic, personIds, departmentIds };
}

export async function getViewer(activeDepartmentIdHint?: string | null): Promise<Viewer> {
  const session = await getSession();
  if (!session) redirect("/login");
  const org = loadOrg();
  const actingPerson = session.impersonated
    ? org.byId.get(session.impersonated.id) ?? session.impersonated
    : session.person;
  const previewing = !!session.impersonated && session.impersonated.id !== session.person.id;
  const { role, isHolistic, personIds, departmentIds } = scopeFor(actingPerson, org);
  const enabledDepartments = org.departments.filter((d) => !!d.enabled);

  const store = await cookies();
  // A user's own cookie choice always wins; otherwise land on the configured
  // default department (HFM IT QA) when it is enabled. This changes only which
  // views are scoped first — it never grants access.
  const configuredDefault = get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_department_id'")?.value ?? null;
  const cookieDept = activeDepartmentIdHint ?? store.get("qa_dept")?.value ?? null;
  const candidate = cookieDept ?? configuredDefault;
  const activeDepartmentId =
    candidate && enabledDepartments.some((d) => d.id === candidate) ? candidate : null;

  return {
    person: session.person,
    actingAs: actingPerson,
    previewing,
    role,
    org,
    departmentIds,
    personIds,
    canSeeAll: isHolistic,
    readOnly: previewing,
    activeDepartmentId,
    enabledDepartments,
  };
}

export async function requireViewer(): Promise<Viewer> {
  return getViewer();
}

export function roleAtLeast(viewer: Viewer, minimum: string): boolean {
  return (ROLE_RANK[viewer.role] ?? 0) >= (ROLE_RANK[minimum] ?? 99);
}

export function canEdit(viewer: Viewer): boolean {
  return !viewer.readOnly && ROLE_RANK[viewer.role] >= ROLE_RANK.editor;
}

export function canAdmin(viewer: Viewer): boolean {
  // Whole-application administration (HFM seed: APPLICATION_ADMIN ≡ 'admin').
  return !viewer.readOnly && viewer.role === "admin";
}

/** Department-scoped administration for the acting person (HFM: DEPARTMENT_ADMIN). */
export function canAdminDepartment(viewer: Viewer, departmentId: string | null | undefined): boolean {
  if (viewer.readOnly) return false;
  if (!departmentId) return false;
  if (viewer.role === "admin" || viewer.role === "exec") return true;
  return viewer.role === "department_admin" && scopedDepartmentId(viewer.person as any) === departmentId;
}

/** True when the viewer may manage `targetDepartmentId`'s people/activities. */
export function canManageDepartment(viewer: Viewer, targetDepartmentId: string | null | undefined): boolean {
  if (viewer.readOnly) return false;
  if (viewer.role === "admin") return true;
  if (viewer.role === "manager") return true; // sub-tree limits are enforced separately in actions
  if (viewer.role === "department_admin") return scopedDepartmentId(viewer.person as any) === targetDepartmentId;
  return false;
}

export function canManagePeople(viewer: Viewer): boolean {
  return !viewer.readOnly && ROLE_RANK[viewer.role] >= ROLE_RANK.manager;
}

/** Effective department filter for a query, honouring the department switcher. */
export function departmentScope(viewer: Viewer): string[] {
  const ids = [...viewer.departmentIds];
  if (viewer.activeDepartmentId) return ids.filter((id) => id === viewer.activeDepartmentId);
  return ids;
}

export function personName(viewer: Viewer, id?: string | null): string {
  if (!id) return "Unassigned";
  return viewer.org.byId.get(id)?.name ?? "Unknown person";
}

export function visiblePersonIds(viewer: Viewer): string[] {
  return [...viewer.personIds];
}
