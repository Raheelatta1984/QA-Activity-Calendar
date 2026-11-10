import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { all, get } from "./db";
import { getSession, type Person } from "./auth";
import { legacyCompanyId, listCompanies, type CompanyRow } from "./org";

export const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  department_admin: 4, // department-scoped administrator (HFM seed: DEPARTMENT_ADMIN)
  exec: 4,
  admin: 5, // whole-application administrator (HFM seed: APPLICATION_ADMIN)
};

/** Cookie keys used by the tenant / department scope switcher. */
export const COMPANY_COOKIE = "qa_company";
export const ENTITY_COOKIE = "qa_entity";
export const DEPARTMENTS_COOKIE = "qa_depts";
/** Legacy single-department cookie — still honoured until the next selection. */
export const LEGACY_DEPARTMENT_COOKIE = "qa_dept";

export type Department = {
  id: string;
  company_id: string;
  entity_id?: string | null;
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
  is_default?: number;
  code?: string | null;
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
  /** Enabled departments this viewer may operate in, within the selected company. */
  departmentIds: Set<string>;
  personIds: Set<string>;
  canSeeAll: boolean;
  readOnly: boolean;
  /** Exactly one department selected, or null when several/all are selected. */
  activeDepartmentId: string | null;
  /** Department scope chosen in the switcher (empty = all authorised). */
  activeDepartmentIds: string[];
  enabledDepartments: Department[];
  /** Tenants this account may switch between. */
  companies: Company[];
  selectedEntityId: string | null;
  /** All entities under the selected company. */
  entities: Array<{ id: string; company_id: string; name: string; code: string | null }>;
};

const FALLBACK_COMPANY: Company = {
  id: "co_default",
  name: "HFM",
  legal_name: null,
  timezone: "Australia/Sydney",
  fiscal_start_month: 7,
  is_default: 0,
};

function parseDepartmentCookie(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Load one tenant's organisation slice. A company id is always required to
 * narrow the departments and people: the default company is only a *selection*,
 * never a grant of cross-company access.
 */
export function loadOrg(companyId?: string | null): Org {
  const configuredDefault = get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'default_company_id'"
  )?.value;
  const company =
    (companyId
      ? get<Company>("SELECT * FROM companies WHERE id = ?", companyId)
      : undefined) ??
    get<Company>("SELECT * FROM companies WHERE is_default = 1 LIMIT 1") ??
    (configuredDefault
      ? get<Company>("SELECT * FROM companies WHERE id = ?", configuredDefault)
      : undefined) ??
    get<Company>("SELECT * FROM companies ORDER BY created_at LIMIT 1") ??
    FALLBACK_COMPANY;

  const departments = company.id === FALLBACK_COMPANY.id && !get("SELECT 1 FROM companies LIMIT 1")
    ? []
    : all<Department>(
        "SELECT * FROM departments WHERE company_id = ? ORDER BY sort_order, name",
        company.id
      );

  // Department-less people belong to the oldest company only (the pre-tenancy
  // workspace). They are never duplicated into, or leaked from, another tenant.
  const oldestCompanyId = legacyCompanyId();
  const people =
    oldestCompanyId && oldestCompanyId === company.id
      ? all<Person>(
          `SELECT p.* FROM people p
             LEFT JOIN departments d ON d.id = p.department_id
            WHERE d.id IS NULL OR d.company_id = ?
            ORDER BY p.name`,
          company.id
        )
      : all<Person>(
          `SELECT p.* FROM people p
             JOIN departments d ON d.id = p.department_id
            WHERE d.company_id = ?
            ORDER BY p.name`,
          company.id
        );

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

/** Department a department_admin is scoped to (NULL for every other role). */
export function scopedDepartmentId(
  person: Pick<Person, "role"> & { role_scope_department_id?: string | null }
): string | null {
  return person.role === "department_admin" ? (person.role_scope_department_id ?? null) : null;
}

export function scopeFor(person: Person, org: Org) {
  const role = person.role;
  const isHolistic = role === "admin" || role === "exec";
  const scopedDept = scopedDepartmentId(person as any);
  // A department_admin sees their own department in full (they manage it);
  // every other role sees only their own sub-tree. Nothing reaches upward.
  const personIds = isHolistic
    ? new Set(org.people.map((p) => p.id))
    : role === "department_admin" && scopedDept
      ? new Set([
          ...org.people.filter((p) => p.department_id === scopedDept).map((p) => p.id),
          person.id,
        ])
      : descendantsOf(org.people, person.id);
  // Disabled departments are excluded from operational views for everyone;
  // admins can still see them in Master Setup to re-enable.
  const departmentIds =
    role === "department_admin" && scopedDept
      ? new Set(org.departments.filter((d) => d.id === scopedDept && !!d.enabled).map((d) => d.id))
      : new Set(org.departments.filter((d) => !!d.enabled).map((d) => d.id));
  return { role, isHolistic, personIds, departmentIds };
}

/** Companies a person is entitled to select, never inferred from a cookie. */
export function companiesForPerson(person: Person, companies: Company[]): Company[] {
  if (person.role === "admin") return companies;
  const ids = new Set<string>();
  const own = person.department_id
    ? get<{ company_id: string }>("SELECT company_id FROM departments WHERE id = ?", person.department_id)
    : undefined;
  if (own?.company_id) ids.add(own.company_id);
  for (const row of all<{ company_id: string }>(
    `SELECT DISTINCT d.company_id
       FROM people p JOIN departments d ON d.id = p.department_id
      WHERE p.linked_person_id = ? AND p.active = 1`,
    person.id
  )) {
    if (row.company_id) ids.add(row.company_id);
  }
  // An account with no department is a pre-tenancy identity: attach it to the
  // legacy workspace only, never to a newly provisioned or default tenant.
  if (!ids.size) {
    const primary =
      legacyCompanyId(companies) ??
      (companies.find((company) => company.is_default === 1)?.id ?? companies[0]?.id);
    if (primary) ids.add(primary);
  }
  return companies.filter((company) => ids.has(company.id));
}

/** Resolve the tenant-local identity for a session principal. */
function actingPersonFor(
  sessionPerson: Person,
  companyId: string
): { acting: Person; preview: boolean } | null {
  const inCompany = (candidate: Person | undefined | null) => {
    if (!candidate) return false;
    if (!candidate.department_id) return false;
    const dept = get<{ company_id: string }>(
      "SELECT company_id FROM departments WHERE id = ?",
      candidate.department_id
    );
    return dept?.company_id === companyId;
  };
  const self = get<Person>("SELECT * FROM people WHERE id = ?", sessionPerson.id);
  if (self && inCompany(self)) return { acting: self, preview: false };
  const linked = get<Person>(
    `SELECT p.* FROM people p JOIN departments d ON d.id = p.department_id
      WHERE p.linked_person_id = ? AND d.company_id = ? AND p.active = 1
      ORDER BY p.created_at LIMIT 1`,
    sessionPerson.id,
    companyId
  );
  if (linked) {
    // Never escalate: the linked identity cannot exceed the account's own role.
    const role =
      (ROLE_RANK[linked.role] ?? 0) <= (ROLE_RANK[sessionPerson.role] ?? 0)
        ? linked.role
        : sessionPerson.role;
    return { acting: { ...linked, role }, preview: false };
  }
  // Whole-application administrators may open any tenant; keep their real
  // identity (and therefore their name) while the org slice stays tenant-scoped.
  if (sessionPerson.role === "admin") return { acting: sessionPerson, preview: false };
  return null;
}

export async function getViewer(activeDepartmentIdHint?: string | null): Promise<Viewer> {
  const session = await getSession();
  if (!session) redirect("/login");

  const allCompanies = listCompanies() as unknown as Company[];
  const permitted = companiesForPerson(session.person, allCompanies);
  const store = await cookies();

  const configuredDefaultId =
    get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_company_id'")?.value ?? null;
  const cookieCompany = store.get(COMPANY_COOKIE)?.value ?? null;
  const selectedCompanyId =
    (cookieCompany && permitted.some((c) => c.id === cookieCompany) ? cookieCompany : null) ??
    (configuredDefaultId && permitted.some((c) => c.id === configuredDefaultId)
      ? configuredDefaultId
      : null) ??
    (permitted.find((c) => c.is_default === 1)?.id ?? permitted[0]?.id ?? "");

  const org = loadOrg(selectedCompanyId);
  // Impersonation is resolved inside the selected tenant only: an admin cannot
  // preview a person from another company through a stale session id.
  const previewTarget =
    session.impersonated && session.impersonated.id !== session.person.id
      ? get<Person>("SELECT * FROM people WHERE id = ?", session.impersonated.id)
      : undefined;
  const previewInCompany = previewTarget?.department_id
    ? org.deptById.has(previewTarget.department_id)
    : false;
  const acting = previewInCompany
    ? { acting: previewTarget as Person, preview: true }
    : actingPersonFor(session.person, org.company.id);
  // A permitted company always has an identity (own row, linked row or admin).
  const actingAs = acting?.acting ?? session.person;
  const previewing = !!acting?.preview;

  const entities = all<{ id: string; company_id: string; name: string; code: string | null }>(
    "SELECT id, company_id, name, code FROM entities WHERE company_id = ? ORDER BY name",
    org.company.id
  );
  const cookieEntity = store.get(ENTITY_COOKIE)?.value ?? null;
  const selectedEntityId =
    cookieEntity && entities.some((entity) => entity.id === cookieEntity) ? cookieEntity : null;

  const scoped = scopeFor(actingAs, org);
  const entityDepartments = selectedEntityId
    ? org.departments.filter((d) => d.entity_id === selectedEntityId)
    : org.departments;
  const departmentIds = new Set(
    [...scoped.departmentIds].filter((id) => entityDepartments.some((d) => d.id === id))
  );
  const enabledDepartments = org.departments.filter(
    (d) => !!d.enabled && departmentIds.has(d.id)
  );

  const cookieDepartments = parseDepartmentCookie(store.get(DEPARTMENTS_COOKIE)?.value);
  const legacyDepartment = activeDepartmentIdHint ?? store.get(LEGACY_DEPARTMENT_COOKIE)?.value ?? null;
  const chosen = (cookieDepartments.length ? cookieDepartments : legacyDepartment ? [legacyDepartment] : []).filter(
    (id) => departmentIds.has(id)
  );
  const activeDepartmentIds = [...new Set(chosen)];

  return {
    person: session.person,
    actingAs,
    previewing,
    role: actingAs.role,
    org,
    departmentIds,
    personIds: new Set([...scoped.personIds].filter((id) => org.byId.has(id) || id === actingAs.id)),
    canSeeAll: scoped.isHolistic,
    readOnly: previewing,
    activeDepartmentId: activeDepartmentIds.length === 1 ? activeDepartmentIds[0] : null,
    activeDepartmentIds,
    enabledDepartments,
    companies: permitted,
    selectedEntityId,
    entities,
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
  return viewer.role === "department_admin" && scopedDepartmentId(viewer.actingAs as any) === departmentId;
}

/** True when the viewer may manage `targetDepartmentId`'s people/activities. */
export function canManageDepartment(viewer: Viewer, targetDepartmentId: string | null | undefined): boolean {
  if (viewer.readOnly) return false;
  if (viewer.role === "admin") return true;
  if (viewer.role === "manager") return true; // sub-tree limits are enforced separately in actions
  if (viewer.role === "department_admin") return scopedDepartmentId(viewer.actingAs as any) === targetDepartmentId;
  return false;
}

export function canManagePeople(viewer: Viewer): boolean {
  return !viewer.readOnly && ROLE_RANK[viewer.role] >= ROLE_RANK.manager;
}

/** Departments selected in the switcher, or every authorised department. */
export function departmentScope(viewer: Viewer): string[] {
  const selected = viewer.activeDepartmentIds ?? [];
  const ids = [...viewer.departmentIds];
  if (selected.length) return ids.filter((id) => selected.includes(id));
  if (viewer.activeDepartmentId) return ids.filter((id) => id === viewer.activeDepartmentId);
  return ids;
}

export function matchesDepartment(viewer: Viewer, departmentId: string | null | undefined): boolean {
  if (!departmentId) return false;
  if (!viewer.departmentIds.has(departmentId)) return false;
  const selected = viewer.activeDepartmentIds ?? [];
  return selected.length === 0 || selected.includes(departmentId);
}

/** Department belongs to the selected company and the viewer may see it. */
export function departmentInCompany(viewer: Viewer, departmentId: string | null | undefined): boolean {
  if (!departmentId) return false;
  if (!viewer.org.deptById.has(departmentId)) return false;
  return viewer.canSeeAll || viewer.departmentIds.has(departmentId);
}

/** Person belongs to the selected company (and the viewer's downward scope). */
export function personInCompany(viewer: Viewer, personId: string | null | undefined): boolean {
  if (!personId) return false;
  if (!viewer.org.byId.has(personId)) return false;
  return viewer.canSeeAll || viewer.personIds.has(personId);
}

export function personName(viewer: Viewer, id?: string | null): string {
  if (!id) return "Unassigned";
  return viewer.org.byId.get(id)?.name ?? "Unknown person";
}

export function visiblePersonIds(viewer: Viewer): string[] {
  return [...viewer.personIds];
}

/** Selected tenant id — every company-owned query must use this. */
export function tenantId(viewer: Viewer): string {
  return viewer.org.company.id;
}

/** Companies a viewer may see in administrative surfaces. */
export function viewerCompanies(viewer: Viewer): CompanyRow[] {
  const permitted = new Set(viewer.companies.map((company) => company.id));
  return listCompanies().filter((company) => permitted.has(company.id));
}
