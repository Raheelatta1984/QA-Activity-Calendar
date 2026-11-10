import { Fragment } from "react";
import { getViewer, canAdmin } from "@/lib/access";
import { defaultSourceCompanyId, defaultTargetCompanyId, listInjectionBatches, previewTenantInjection } from "@/lib/tenant-injection";
import { all, setting } from "@/lib/db";
import { listCompanies, listEntities } from "@/lib/org";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { CompanyForm } from "@/components/SetupForms";
import { TenantDataPanel } from "@/components/TenantDataPanel";
import { PeoplePanel } from "@/components/PeoplePanel";
import { OrgTree } from "@/components/OrgTree";
import { Icon } from "@/components/icons";
import {
  saveDepartmentAction,
  toggleDepartmentAction,
  setDefaultCompanyAction,
  toggleTabAction,
  toggleSectionAction,
  saveHolidayAction,
  deleteHolidayAction,
  saveSettingsAction,
} from "@/app/actions/admin";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const viewer = await getViewer();
  const admin = canAdmin(viewer);
  const settings = appSettings();
  const org = viewer.org;

  // Everything below is scoped to the selected tenant. The all-companies table
  // is a deliberate administrative summary (admin-only controls), never a data
  // query for another company's records.
  const departments = org.departments;
  const allEntityRows = listEntities();
  const entities = allEntityRows.filter((entity) => entity.company_id === org.company.id);
  const allCompanies = listCompanies();
  const permittedCompanyIds = new Set(viewer.companies.map((company) => company.id));
  const companies = admin
    ? allCompanies
    : allCompanies.filter((company) => permittedCompanyIds.has(company.id));
  const entitiesByCompany = new Map<string, typeof allEntityRows>(
    companies.map((c) => [c.id, allEntityRows.filter((e) => e.company_id === c.id)])
  );
  const entityName = (id: string | null | undefined) => allEntityRows.find((e) => e.id === id)?.name ?? null;
  const people = org.people;
  const tenantPreview = previewTenantInjection({
    sourceCompanyId: defaultSourceCompanyId(),
    targetCompanyId: defaultTargetCompanyId(),
  });
  const injections = listInjectionBatches(defaultTargetCompanyId());
  const tabs = all<any>(`SELECT * FROM tabs ORDER BY sort_order`);
  const sections = all<any>(`SELECT * FROM sections ORDER BY sort_order`);
  const holidays = all<any>(`SELECT * FROM holidays ORDER BY date DESC LIMIT 40`);
  const colourRules = all<any>(`SELECT * FROM colour_rules ORDER BY name`);
  const noteCounts = all<{ section_id: string | null; tab_id: string; n: number }>(
    `SELECT tab_id, section_id, COUNT(*) AS n FROM sticky_notes
      WHERE company_id = ? OR ai_generated = 1
      GROUP BY tab_id, section_id`,
    org.company.id
  );
  const audit = all<any>(
    `SELECT * FROM audit_events WHERE company_id = ? ORDER BY at DESC LIMIT 8`,
    org.company.id
  );

  const departmentName = (id: string | null) => departments.find((d) => d.id === id)?.name ?? null;
  const treeNodes = people.map((person) => ({
    id: person.id,
    name: person.name,
    title: person.title,
    role: person.role,
    colour: person.colour,
    manager_id: person.manager_id,
    department_name: departmentName(person.department_id),
    directReports: people.filter((p) => p.manager_id === person.id).length,
  }));

  const activeTabs = tabs.filter((t) => t.enabled).length;
  const enabledDepartments = departments.filter((d) => d.enabled).length;

  return (
    <main className="page">
      <PageHeader
        id="tab.setup" path="/setup" canEdit={admin}
        title="Master setup"
        description="Company entity, departments, organisation hierarchy, employees, tab configuration, holidays and calculation defaults. Every control here is live — no separate admin deployment."
        meta={
          <>
            {companies.length} {companies.length === 1 ? "company" : "companies"} · {entities.length} {entities.length === 1 ? "entity" : "entities"} · {departments.length} departments ({enabledDepartments} enabled) · {people.length} people · {activeTabs}/
            {tabs.length} tabs enabled · fiscal start month {settings.fiscalStartMonth}
          </>
        }
      />

      {!admin ? (
        <div className="banner warn" style={{ marginBottom: 16 }}>
          <Icon name="lock" size={15} />
          <span>
            You are signed in as a <strong>{viewer.role}</strong>. Configuration changes are restricted to
            administrators; you can still review the setup and your own team below.
          </span>
        </div>
      ) : null}

      <PageGuidance id="tab.setup" path="/setup" canEdit={admin} />

      <Section
        id="sec.setup.company"
        tabId="tab.setup"
        title="Company entity"
        description="One entity today, more tomorrow — departments and roles are already scoped to the company."
        path="/setup"
        canEdit={admin}
        bare
      >
        {admin ? (
          <CompanyForm
            company={{
              name: org.company.name,
              legal_name: org.company.legal_name,
              timezone: org.company.timezone,
              fiscal_start_month: org.company.fiscal_start_month,
            }}
          />
        ) : (
          <div className="card card-pad">
            <div className="stat-line"><span className="muted">Name</span><span>{org.company.name}</span></div>
            <div className="stat-line"><span className="muted">Legal entity</span><span>{org.company.legal_name ?? "—"}</span></div>
            <div className="stat-line"><span className="muted">Timezone</span><span>{org.company.timezone}</span></div>
            <div className="stat-line"><span className="muted">Fiscal start</span><span>Month {org.company.fiscal_start_month}</span></div>
          </div>
        )}

        <div className="card-pad stack" style={{ marginTop: 12 }}>
          <div className="label">All companies &amp; entities</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Code</th>
                  <th>Default</th>
                  <th className="num">Entities</th>
                  <th className="num">Departments</th>
                  <th className="num">People</th>
                  <th className="num">Activities</th>
                  {admin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <Fragment key={company.id}>
                    <tr>
                      <td>
                        <strong>{company.name}</strong>
                        {company.aliases ? (
                          <div className="muted" style={{ fontSize: "0.72rem" }}>also known as {(() => { try { return JSON.parse(company.aliases!).join(", "); } catch { return company.aliases; } })()}</div>
                        ) : null}
                      </td>
                      <td className="mono">{company.code ?? "—"}</td>
                      <td>
                        {company.is_default ? (
                          <span className="badge badge-green">default</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">{company.entity_count}</td>
                      <td className="num">{company.department_count}</td>
                      <td className="num">{company.person_count}</td>
                      <td className="num">{company.activity_count}</td>
                      {admin ? (
                        <td className="right">
                          {!company.is_default ? (
                            <form action={setDefaultCompanyAction}>
                              <input type="hidden" name="id" value={company.id} />
                              <button className="btn btn-sm btn-ghost" type="submit" title="Make this the company shown by default and at login">
                                Make default
                              </button>
                            </form>
                          ) : (
                            <span className="muted" style={{ fontSize: "0.75rem" }}>active at login</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                    {(entitiesByCompany.get(company.id) ?? []).map((entity) => (
                      <tr key={entity.id} style={{ background: "var(--surface-2)" }}>
                        <td style={{ paddingLeft: 28 }}>
                          <Icon name="layers" size={12} /> {entity.name}
                        </td>
                        <td className="mono">{entity.code ?? "—"}</td>
                        <td className="muted">entity</td>
                        <td className="num muted">—</td>
                        <td className="num">{entity.department_count}</td>
                        <td className="num">{entity.person_count}</td>
                        <td className="num muted">—</td>
                        {admin ? <td /> : null}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-sub">
            The default company drives which company renders first and which scope the login screen opens on. It never
            grants cross-company access. Departments link to an entity when one exists; otherwise they sit directly under the company.
          </div>
        </div>
      </Section>

      <Section
        id="sec.setup.tenants"
        tabId="tab.setup"
        title="Tenant data — Harrisfarm Markets"
        description="A separate company (code HFM2) with its own entity and departments. Copy HFM's activities, releases, pipeline and related data into it, clearly tagged and reversible; delete only the copies, never the originals."
        path="/setup"
        canEdit={admin}
        bare
      >
        {admin ? <TenantDataPanel
          canAdmin={admin}
          source={tenantPreview.source ? { id: tenantPreview.source.id, name: tenantPreview.source.name } : null}
          target={tenantPreview.target ? { id: tenantPreview.target.id, name: tenantPreview.target.name } : null}
          tables={tenantPreview.tables}
          batches={injections.map((batch) => ({
            id: batch.id,
            label: batch.label,
            status: batch.status,
            counts: batch.counts as unknown as Record<string, number>,
            created_at: batch.created_at,
          }))}
          targetPeople={tenantPreview.targetPeople}
        /> : null}
      </Section>

      <Section
        id="sec.setup.departments"
        tabId="tab.setup"
        title="Departments"
        description="Disable a department to remove it from operational views without deleting a single record. Add departments any time — the app is designed to extend beyond QA."
        path="/setup"
        canEdit={admin}
      >
        <div className="card-pad stack">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Entity</th>
                  <th>Description</th>
                  <th>Colour</th>
                  <th className="num">People</th>
                  <th className="num">Activities</th>
                  <th>State</th>
                  {admin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {departments.map((department) => (
                  <tr key={department.id}>
                    <td className="mono">{department.code}</td>
                    <td><strong>{department.name}</strong></td>
                    <td className="muted">{entityName(department.entity_id) ?? "—"}</td>
                    <td className="muted">{department.description ?? "—"}</td>
                    <td>
                      <span className="legend-swatch" style={{ background: department.colour }} />
                    </td>
                    <td className="num">{people.filter((p) => p.department_id === department.id).length}</td>
                    <td className="num">{all<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE department_id = ?`, department.id)[0]?.n ?? 0}</td>
                    <td>
                      <span className={`badge ${department.enabled ? "badge-green" : "badge-slate"}`}>
                        {department.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    {admin ? (
                      <td className="right">
                        <form action={toggleDepartmentAction}>
                          <input type="hidden" name="id" value={department.id} />
                          <button className="btn btn-sm btn-ghost" type="submit">
                            {department.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {admin ? (
            <details className="card" style={{ padding: "10px 14px" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
                <Icon name="plus" size={13} /> Add a department
              </summary>
              <form action={saveDepartmentAction} className="form-grid" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Entity</label>
                  <select className="select select-sm" name="entityId" defaultValue={entities[0]?.id ?? ""}>
                    <option value="">— company (no entity)</option>
                    {entities.map((entity) => (
                      <option key={entity.id} value={entity.id}>{entity.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Name</label>
                  <input className="input input-sm" name="name" required placeholder="Data Engineering" />
                </div>
                <div className="field">
                  <label>Code</label>
                  <input className="input input-sm" name="code" placeholder="DATA" />
                </div>
                <div className="field">
                  <label>Colour</label>
                  <input className="input input-sm" type="color" name="colour" defaultValue="#4f8cff" style={{ padding: 4, height: 34 }} />
                </div>
                <div className="field span-2">
                  <label>Description</label>
                  <input className="input input-sm" name="description" />
                </div>
                <div className="form-actions span-2">
                  <button className="btn btn-sm btn-primary" type="submit">Add department</button>
                </div>
              </form>
            </details>
          ) : null}

          <div className="banner info">
            <Icon name="info" size={15} />
            <span>
              Disabled departments are excluded from calendars, capacity and reporting for everyone. Their records stay
              intact so re-enabling restores the full history.
            </span>
          </div>
        </div>
      </Section>

      <Section
        id="sec.setup.hierarchy"
        tabId="tab.setup"
        title="Organisation hierarchy"
        description="Drag-and-drop reporting lines. Moving a person moves their whole sub-tree and recalculates who can see what."
        path="/setup"
        canEdit={admin}
      >
        <div className="card-pad">
          <OrgTree people={treeNodes} canEdit={admin} />
        </div>
      </Section>

      <Section
        id="sec.setup.people"
        tabId="tab.setup"
        title="Employees"
        description="Roles: viewer (read own team), editor (change activities), manager (manage team), exec (holistic read), admin (full control)."
        path="/setup"
        canEdit={admin}
        bare
      >
        <PeoplePanel
          people={people.map((p) => ({
            id: p.id,
            name: p.name,
            email: p.email,
            title: p.title,
            role: p.role,
            manager_id: p.manager_id,
            department_id: p.department_id,
            capacity_hours_day: p.capacity_hours_day,
            active: p.active,
          }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          canEdit={admin}
        />
      </Section>

      <Section
        id="sec.setup.tabs"
        tabId="tab.setup"
        title="Tabs, sections & stable IDs"
        description="Disable any tab or section without deleting code or data. Every tab (tab.*) and section (sec.*) has a stable ID to quote in enhancement requests."
        path="/setup"
        canEdit={admin}
        bare
      >
        <div className="card card-pad stack">
          {tabs.map((tab) => {
            const tabSections = sections.filter((s) => s.tab_id === tab.id);
            const tabNotes = noteCounts.filter((n) => n.tab_id === tab.id).reduce((sum, n) => sum + n.n, 0);
            return (
              <details key={tab.id} open={tab.id === "tab.calendar" || tab.id === "tab.dashboard"}>
                <summary style={{ cursor: "pointer", padding: "6px 0" }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="badge badge-slate mono" style={{ fontSize: "0.66rem" }}>{tab.id}</span>
                    <strong style={{ fontSize: "0.9rem" }}>{tab.label}</strong>
                    <span className="card-sub">{tab.group_name}</span>
                    {tab.enabled ? (
                      <span className="badge badge-green">enabled</span>
                    ) : (
                      <span className="badge badge-slate">disabled</span>
                    )}
                    <span className="badge badge-blue">{tabNotes} notes</span>
                    <span className="badge badge-slate">min role: {tab.min_role}</span>
                  </span>
                </summary>

                <div className="stack-sm" style={{ margin: "8px 0 12px 0" }}>
                  <div className="row-between">
                    <span className="card-sub">{tab.description}</span>
                    {admin ? (
                      <form action={toggleTabAction}>
                        <input type="hidden" name="id" value={tab.id} />
                        <button className={`btn btn-sm ${tab.enabled ? "btn-danger" : ""}`} type="submit">
                          {tab.enabled ? "Disable tab" : "Enable tab"}
                        </button>
                      </form>
                    ) : null}
                  </div>

                  {tabSections.map((section) => (
                    <div key={section.id} className="row-between card" style={{ padding: "8px 12px" }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{section.id}</span>
                          <strong style={{ fontSize: "0.84rem" }}>{section.label}</strong>
                          {section.enabled ? (
                            <span className="badge badge-green">enabled</span>
                          ) : (
                            <span className="badge badge-slate">disabled</span>
                          )}
                        </div>
                        <div className="card-sub">{section.description}</div>
                      </div>
                      {admin ? (
                        <form action={toggleSectionAction}>
                          <input type="hidden" name="id" value={section.id} />
                          <button className="btn btn-sm btn-ghost" type="submit">
                            {section.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </Section>

      <Section
        id="sec.setup.holidays"
        tabId="tab.setup"
        title="Holidays, colours & calculation defaults"
        description="NSW public holidays and the colour dictionary are configuration. Calculation defaults stay configurable rather than hard-coded."
        path="/setup"
        canEdit={admin}
      >
        <div className="card-pad grid-2">
          <div className="stack-sm">
            <div className="label">NSW public holidays</div>
            {admin ? (
              <form action={saveHolidayAction} className="inline-form">
                <div className="field">
                  <label>Date</label>
                  <input className="input input-sm" type="date" name="date" required />
                </div>
                <div className="field grow" style={{ minWidth: 160 }}>
                  <label>Name</label>
                  <input className="input input-sm" name="name" required placeholder="Bank holiday" />
                </div>
                <button className="btn btn-sm btn-primary" type="submit">Add</button>
              </form>
            ) : null}
            <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Name</th>
                    <th>Source</th>
                    {admin ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((holiday) => (
                    <tr key={holiday.id}>
                      <td className="mono nowrap">{holiday.date}</td>
                      <td>{holiday.name}</td>
                      <td className="muted" style={{ fontSize: "0.72rem" }}>{holiday.source ?? "—"}</td>
                      {admin ? (
                        <td className="right">
                          <form action={deleteHolidayAction}>
                            <input type="hidden" name="id" value={holiday.id} />
                            <button className="btn btn-sm btn-ghost" type="submit" title="Delete">
                              <Icon name="trash" size={12} />
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-sub">
              Holidays are never fetched automatically. Add new years from the approved NSW source.
            </div>
          </div>

          <div className="stack-sm">
            <div className="label">Colour dictionary</div>
            <div className="row" style={{ gap: 6 }}>
              {colourRules.map((rule) => (
                <span className="badge badge-slate" key={rule.id} title={rule.meaning ?? ""}>
                  <span className="legend-swatch" style={{ background: rule.hex }} /> {rule.name}
                </span>
              ))}
            </div>

            <div className="divider" />

            <div className="label">Calculation defaults</div>
            {admin ? (
              <form action={saveSettingsAction} className="form-grid">
                <div className="field">
                  <label>Regression FTE</label>
                  <input className="input input-sm" type="number" step="0.1" name="fte.regression_value" defaultValue={setting("fte.regression_value", "1")} />
                </div>
                <div className="field">
                  <label>Default FTE</label>
                  <input className="input input-sm" type="number" step="0.1" name="fte.default_value" defaultValue={setting("fte.default_value", "0.5")} />
                </div>
                <div className="field">
                  <label>Hours per day</label>
                  <input className="input input-sm" type="number" step="0.1" name="fte.hours_per_day" defaultValue={setting("fte.hours_per_day", "7.6")} />
                </div>
                <div className="field">
                  <label>App name</label>
                  <input className="input input-sm" name="app.name" defaultValue={setting("app.name", "HFM QA Activity Calendar")} />
                </div>
                <label className="check span-2">
                  <input
                    type="checkbox"
                    name="capacity.include_unavailable"
                    defaultChecked={setting("capacity.include_unavailable", "true") === "true"}
                  />
                  Include unavailable hours in occupied capacity (source behaviour)
                </label>
                <div className="form-actions span-2">
                  <button className="btn btn-sm btn-primary" type="submit">Save defaults</button>
                </div>
              </form>
            ) : (
              <div className="card-sub">
                Regression FTE {setting("fte.regression_value", "1")} · default {setting("fte.default_value", "0.5")} ·
                hours/day {setting("fte.hours_per_day", "7.6")}
              </div>
            )}

            <div className="divider" />
            <div className="label">Recent configuration audit</div>
            <div className="stack-sm">
              {audit.map((event) => (
                <div className="row-between" key={event.id} style={{ fontSize: "0.76rem" }}>
                  <span>
                    <strong>{event.actor_name ?? "system"}</strong>{" "}
                    <span className="muted">{event.action}</span>
                  </span>
                  <span className="mono muted">{String(event.at).slice(5, 16)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
