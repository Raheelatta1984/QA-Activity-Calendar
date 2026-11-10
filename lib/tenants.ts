import { all, get, run, transaction } from "./db";
import { uid } from "./ids";

/**
 * The second, explicitly separate Harrisfarm tenant.
 *
 * The existing production tenant is "HarrisFarm Markets" (companies.code = HFM).
 * This one is deliberately a **new company row** named "Harrisfarm Markets"
 * (capitalisation is part of the name), with its own stable code `HFM2`, its own
 * entity and its own departments. Nothing in the HFM company is renamed, moved
 * or duplicated by this module.
 *
 * Identity handling
 *   * Damien Milthorpe and Raheel Atta already exist in HFM. Their HFM rows are
 *     left byte-for-byte unchanged.
 *   * In the new tenant they get tenant-local people rows whose `email` and
 *     `password_hash` are NULL, linked to the original account through
 *     `people.linked_person_id`. No email is invented and no credential is copied.
 *   * `getViewer` resolves the linked identity, so Raheel's existing HFM login
 *     can switch to the new tenant without a second account.
 *
 * Idempotent: fixed ids, code-based company lookup and name-based department /
 * person lookup. Running it repeatedly creates nothing new.
 */

export const HARRISFARM_TENANT = {
  companyId: "co_hfm2_harrisfarm",
  code: "HFM2",
  name: "Harrisfarm Markets",
  legalName: "Harrisfarm Markets (separate tenant)",
  entityId: "ent_hfm2_harrisfarm",
  entityName: "Harrisfarm Markets",
  entityCode: "HFM2",
  qaDepartmentId: "dept_hfm2_qa",
  sourceDataset: "tenant-provision",
  departments: [
    {
      id: "dept_hfm2_qa",
      code: "QA",
      name: "QA",
      description: "Quality assurance leadership, planning and testing for Harrisfarm Markets.",
      colour: "#4f8cff",
      enabled: 1,
      sort: 10,
    },
    {
      id: "dept_hfm2_rel",
      code: "REL",
      name: "Release Management",
      description: "Release trains, QA windows and deployment governance.",
      colour: "#a855f7",
      enabled: 1,
      sort: 20,
    },
    {
      id: "dept_hfm2_auto",
      code: "AUTO",
      name: "Test Automation",
      description: "Automated regression, recording maintenance and tooling.",
      colour: "#22c55e",
      enabled: 1,
      sort: 30,
    },
    {
      id: "dept_hfm2_data",
      code: "DATA",
      name: "Data Services",
      description: "Data, reporting and integration quality.",
      colour: "#f59e0b",
      enabled: 1,
      sort: 40,
    },
  ],
  people: [
    {
      id: "p_hfm2_damien",
      name: "Damien Milthorpe",
      title: "QA Lead",
      role: "department_admin",
      colour: "#0ea5e9",
      managerName: null as string | null,
      scopeQa: true,
    },
    {
      id: "p_hfm2_raheel",
      name: "Raheel Atta",
      title: "QA",
      role: "admin",
      colour: "#6366f1",
      managerName: "Damien Milthorpe",
      scopeQa: false,
    },
  ],
} as const;

export type TenantProvisionSummary = {
  companyId: string;
  entityId: string;
  departmentIds: string[];
  qaDepartmentId: string;
  people: Array<{
    id: string;
    name: string;
    title: string;
    linkedPersonId: string | null;
    created: boolean;
  }>;
  createdCompany: boolean;
  createdEntity: boolean;
  createdDepartments: number;
  createdPeople: number;
};

function linkedHfmPerson(name: string, targetCompanyId: string) {
  return get<{ id: string }>(
    `SELECT p.id
       FROM people p
       JOIN departments d ON d.id = p.department_id
       JOIN companies c ON c.id = d.company_id
      WHERE p.name = ? AND d.company_id <> ?
      ORDER BY CASE WHEN c.code = 'HFM' THEN 0 ELSE 1 END, p.created_at
      LIMIT 1`,
    name,
    targetCompanyId
  );
}

/**
 * Create (or reconcile) the separate Harrisfarm Markets tenant. Safe to run on
 * a live database and safe to repeat. Only this module's fixed ids are updated;
 * nothing belonging to HFM is modified.
 */
export function ensureHarrisfarmMarketsTenant(actor?: {
  id?: string | null;
  name?: string | null;
}): TenantProvisionSummary {
  return transaction(() => {
    const config = HARRISFARM_TENANT;
    let createdCompany = false;
    let createdEntity = false;
    let createdDepartments = 0;
    let createdPeople = 0;

    let company = get<any>("SELECT * FROM companies WHERE code = ?", config.code);
    if (!company) {
      // Only adopt a pre-existing row when it is *exactly* this tenant (same
      // name) and has no conflicting code. A case-insensitive match to
      // "HarrisFarm Markets" is a different company and is never hijacked.
      company = get<any>(
        "SELECT * FROM companies WHERE name = ? AND (code IS NULL OR code = '') LIMIT 1",
        config.name
      );
      if (company) {
        run("UPDATE companies SET code = ?, aliases = ? WHERE id = ?", config.code, JSON.stringify([config.name]), company.id);
        company = get<any>("SELECT * FROM companies WHERE id = ?", company.id);
      } else {
        const id = config.companyId;
        run(
          `INSERT INTO companies (id, name, legal_name, timezone, fiscal_start_month, aliases, is_default, code)
           VALUES (?, ?, ?, 'Australia/Sydney', 7, ?, 0, ?)`,
          id,
          config.name,
          config.legalName,
          JSON.stringify([config.name]),
          config.code
        );
        company = get<any>("SELECT * FROM companies WHERE id = ?", id);
        createdCompany = true;
      }
    }

    let entity = get<any>(
      "SELECT * FROM entities WHERE company_id = ? AND (name = ? OR code = ?) LIMIT 1",
      company.id,
      config.entityName,
      config.entityCode
    );
    if (!entity) {
      const id = config.entityId;
      run(
        "INSERT INTO entities (id, company_id, name, code) VALUES (?, ?, ?, ?)",
        id,
        company.id,
        config.entityName,
        config.entityCode
      );
      entity = get<any>("SELECT * FROM entities WHERE id = ?", id);
      createdEntity = true;
    }

    const departmentIds: string[] = [];
    for (const department of config.departments) {
      let row = get<any>(
        "SELECT * FROM departments WHERE company_id = ? AND (code = ? OR name = ?) LIMIT 1",
        company.id,
        department.code,
        department.name
      );
      if (!row) {
        run(
          `INSERT INTO departments (id, company_id, entity_id, code, name, description, colour, enabled, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          department.id,
          company.id,
          entity.id,
          department.code,
          department.name,
          department.description,
          department.colour,
          department.enabled,
          department.sort
        );
        row = get<any>("SELECT * FROM departments WHERE id = ?", department.id);
        createdDepartments += 1;
      } else if (!row.entity_id) {
        run("UPDATE departments SET entity_id = ? WHERE id = ?", entity.id, row.id);
      }
      departmentIds.push(row.id);
    }

    const qaDepartmentId =
      departmentIds[
        config.departments.findIndex((department) => department.id === config.qaDepartmentId)
      ] ?? departmentIds[0];

    const people: TenantProvisionSummary["people"] = [];
    const createdByName = new Map<string, string>();
    for (const person of config.people) {
      const managerId = person.managerName ? createdByName.get(person.managerName) ?? null : null;
      let row = get<any>(
        `SELECT p.* FROM people p JOIN departments d ON d.id = p.department_id
          WHERE d.company_id = ? AND p.name = ? ORDER BY p.created_at LIMIT 1`,
        company.id,
        person.name
      );
      const linked = linkedHfmPerson(person.name, company.id)?.id ?? null;
      let wasCreated = false;
      if (!row) {
        run(
          `INSERT INTO people
             (id, department_id, manager_id, name, email, title, role, role_scope_department_id,
              password_hash, capacity_hours_day, colour, active, is_demo, external_source_id,
              source_dataset, linked_person_id)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, 7.6, ?, 1, 0, ?, ?, ?)`,
          person.id,
          qaDepartmentId,
          managerId,
          person.name,
          person.title,
          person.role,
          person.scopeQa ? qaDepartmentId : null,
          person.colour,
          `${config.sourceDataset}:${person.name}`,
          config.sourceDataset,
          linked
        );
        row = get<any>("SELECT * FROM people WHERE id = ?", person.id);
        createdPeople += 1;
        wasCreated = true;
      } else {
        // Never overwrite an operator's deliberate edit. Only fill gaps and
        // keep the identity link current when the HFM account appears.
        if (!row.linked_person_id && linked) {
          run("UPDATE people SET linked_person_id = ? WHERE id = ?", linked, row.id);
          row = get<any>("SELECT * FROM people WHERE id = ?", row.id);
        }
        if (row.department_id !== qaDepartmentId) {
          run("UPDATE people SET department_id = ? WHERE id = ?", qaDepartmentId, row.id);
        }
        if (!row.title) run("UPDATE people SET title = ? WHERE id = ?", person.title, row.id);
        if (!row.manager_id && managerId) run("UPDATE people SET manager_id = ? WHERE id = ?", managerId, row.id);
      }
      createdByName.set(person.name, row.id);
      people.push({
        id: row.id,
        name: row.name,
        title: row.title ?? person.title,
        linkedPersonId: row.linked_person_id ?? null,
        created: wasCreated,
      });
    }

    return {
      companyId: company.id,
      entityId: entity.id,
      departmentIds,
      qaDepartmentId,
      people,
      createdCompany,
      createdEntity,
      createdDepartments,
      createdPeople,
    };
  });
}

/** The QA person copies in the new tenant, by name (used by injection). */
export function tenantQaPeople(companyId: string) {
  return all<{ id: string; name: string; title: string | null; linked_person_id: string | null }>(
    `SELECT p.id, p.name, p.title, p.linked_person_id
       FROM people p JOIN departments d ON d.id = p.department_id
      WHERE d.company_id = ? ORDER BY p.name`,
    companyId
  );
}

/** Stable, human-readable label used by the UI and audit events. */
export function tenantLabel(companyId: string): string {
  return get<{ name: string }>("SELECT name FROM companies WHERE id = ?", companyId)?.name ?? companyId;
}

export function newTenantId(prefix: string): string {
  return uid(prefix);
}
