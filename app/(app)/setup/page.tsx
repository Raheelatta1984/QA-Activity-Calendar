import { getViewer, canAdmin } from "@/lib/access";
import { all, setting } from "@/lib/db";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { CompanyForm } from "@/components/SetupForms";
import { PeoplePanel } from "@/components/PeoplePanel";
import { OrgTree } from "@/components/OrgTree";
import { Icon } from "@/components/icons";
import {
  saveDepartmentAction,
  toggleDepartmentAction,
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

  const departments = all<any>(`SELECT * FROM departments ORDER BY sort_order, name`);
  const people = all<any>(`SELECT * FROM people ORDER BY name`);
  const tabs = all<any>(`SELECT * FROM tabs ORDER BY sort_order`);
  const sections = all<any>(`SELECT * FROM sections ORDER BY sort_order`);
  const holidays = all<any>(`SELECT * FROM holidays ORDER BY date DESC LIMIT 40`);
  const colourRules = all<any>(`SELECT * FROM colour_rules ORDER BY name`);
  const noteCounts = all<{ section_id: string | null; tab_id: string; n: number }>(
    `SELECT tab_id, section_id, COUNT(*) AS n FROM sticky_notes GROUP BY tab_id, section_id`
  );
  const audit = all<any>(`SELECT * FROM audit_events ORDER BY at DESC LIMIT 8`);

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
            {departments.length} departments ({enabledDepartments} enabled) · {people.length} people · {activeTabs}/
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
