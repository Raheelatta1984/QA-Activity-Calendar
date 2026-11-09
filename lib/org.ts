import { all, get, run, transaction } from "./db";

/**
 * Organisation lens shared by the login page, Master Setup and the HFM import:
 * Company → Entity → Department → Person. Nothing here invents rows; it only
 * reads and links what other parts of the app own.
 */

export type CompanyRow = {
  id: string;
  name: string;
  legal_name: string | null;
  timezone: string;
  fiscal_start_month: number;
  aliases: string | null;
  is_default: number;
  code: string | null;
  created_at: string;
  entity_count: number;
  department_count: number;
  person_count: number;
  activity_count: number;
};

export type EntityRow = {
  id: string;
  company_id: string;
  name: string;
  code: string | null;
  created_at: string;
  department_count: number;
  person_count: number;
};

const COMPANY_COUNTS = `
  (SELECT COUNT(*) FROM entities e WHERE e.company_id = c.id) AS entity_count,
  (SELECT COUNT(*) FROM departments d WHERE d.company_id = c.id) AS department_count,
  (SELECT COUNT(*) FROM people p JOIN departments d2 ON d2.id = p.department_id WHERE d2.company_id = c.id) AS person_count,
  (SELECT COUNT(*) FROM activities a WHERE a.company_id = c.id) AS activity_count
`;

/** All companies with roll-up counts, default company first. */
export function listCompanies(): CompanyRow[] {
  return all<CompanyRow>(
    `SELECT c.*, ${COMPANY_COUNTS} FROM companies c ORDER BY c.is_default DESC, c.created_at, c.name`
  );
}

export function listEntities(companyId?: string): EntityRow[] {
  const filter = companyId ? "WHERE e.company_id = ?" : "";
  const params = companyId ? [companyId] : [];
  return all<EntityRow>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM departments d WHERE d.entity_id = e.id) AS department_count,
       (SELECT COUNT(*) FROM people p JOIN departments d3 ON d3.id = p.department_id WHERE d3.entity_id = e.id) AS person_count
       FROM entities e ${filter} ORDER BY e.name`,
    ...params
  );
}

export function defaultCompany(): CompanyRow | undefined {
  const companies = listCompanies();
  return companies.find((c) => c.is_default === 1) ?? companies[0];
}

export function setDefaultCompany(companyId: string, actor?: { id: string | null; name: string | null }): CompanyRow {
  const target = get<CompanyRow>(
    `SELECT c.*, ${COMPANY_COUNTS} FROM companies c WHERE c.id = ?`,
    companyId
  );
  if (!target) throw new Error("Company no longer exists.");
  transaction(() => {
    run("UPDATE companies SET is_default = 0 WHERE is_default = 1 AND id <> ?", companyId);
    run("UPDATE companies SET is_default = 1 WHERE id = ?", companyId);
    run(
      `INSERT INTO settings (key, value) VALUES ('default_company_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      companyId
    );
  });
  return get<CompanyRow>(`SELECT c.*, ${COMPANY_COUNTS} FROM companies c WHERE c.id = ?`, companyId)!;
}

/** A sign-in-visible account within one company/entity scope. */
export type LoginAccount = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  title: string | null;
  is_demo: number;
  has_login: number;
  department_name: string | null;
  entity_id: string | null;
};

export type LoginScope = {
  companies: CompanyRow[];
  entities: EntityRow[];
  accounts: LoginAccount[];
  selectedCompanyId: string;
  selectedEntityId: string | null;
};

const ROLE_ORDER = `CASE p.role WHEN 'admin' THEN 1 WHEN 'exec' THEN 2 WHEN 'manager' THEN 3 WHEN 'department_admin' THEN 4 WHEN 'editor' THEN 5 ELSE 6 END`;

/**
 * Accounts shown on the login screen, scoped to a company and optionally one
 * of its entities. Ordering prefers demo identities (they are sign-in-able in
 * the demo environment), then everyone else by role and name. Accounts without
 * a password are listed (so the roster is discoverable) but cannot fill.
 */
export function listLoginAccounts(companyId?: string | null, entityId?: string | null): LoginScope {
  const companies = listCompanies();
  const fallback = defaultCompany();
  const selectedCompanyId =
    (companyId && companies.some((c) => c.id === companyId) ? companyId : undefined) ??
    fallback?.id ??
    companies[0]?.id ??
    "";
  const entities = listEntities(selectedCompanyId);
  const selectedEntityId = entityId && entities.some((e) => e.id === entityId) ? entityId : null;

  // Department-less people belong to no entity and no company. Attach them to
  // the oldest company only (the pre-multitenant workspace) so they are not
  // duplicated under every tenant and never leak into another tenant's roster.
  const oldestCompanyId = [...companies].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || (a.is_default ?? 0) - (b.is_default ?? 0) || a.name.localeCompare(b.name)
  )[0]?.id;
  const companyFilter = selectedEntityId
    ? "d.entity_id = ?"
    : selectedCompanyId === oldestCompanyId
      ? "(d.company_id = ? OR p.department_id IS NULL)"
      : "d.company_id = ?";
  const params = selectedEntityId ? [selectedEntityId] : [selectedCompanyId];

  const accounts = all<LoginAccount>(
    `SELECT p.id, p.name, p.email, p.role, p.title, p.is_demo,
            (p.password_hash IS NOT NULL) AS has_login,
            d.name AS department_name, d.entity_id
       FROM people p
       LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.active = 1 AND ${companyFilter}
      ORDER BY p.is_demo DESC, ${ROLE_ORDER}, p.name`,
    ...params
  );

  return { companies, entities, accounts, selectedCompanyId, selectedEntityId };
}
