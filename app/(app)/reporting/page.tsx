import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { bugProgressByActivity, bugTotals, listBugs, listServices } from "@/lib/bugs";
import { listActivities } from "@/lib/activities";
import { isoToday, monthLabel, monthStart } from "@/lib/dates";
import { canEdit as canEditFn } from "@/lib/access";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { ReportingBoard } from "@/components/ReportingBoard";
import { saveProgressAction } from "@/app/actions/bugs";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function ReportingPage() {
  const viewer = await getViewer();
  const today = isoToday();
  const bugs = listBugs(viewer);
  const totals = bugTotals(bugs);
  const services = listServices();
  const progressByActivity = bugProgressByActivity(bugs);
  const activities = listActivities(viewer, { includeInactive: true, limit: 300 });

  const editable = canEditFn(viewer);
  const completion = activities
    .filter((a) => a.active === 1)
    .map((activity) => {
      const counts = progressByActivity.get(activity.id) ?? {
        reported: 0,
        fixed: 0,
        closed: 0,
        outstanding: 0,
      };
      return { activity, counts };
    })
    .sort((a, b) => b.counts.reported - a.counts.reported)
    .slice(0, 12);

  const serviceRows = services.map((service) => {
    const links = bugs.flatMap((bug) =>
      bug.links.filter((l) => l.service_id === service.id).map((l) => ({ bug, status: l.status }))
    );
    return {
      service,
      total: links.length,
      open: links.filter((l) => l.status === "Open").length,
      fixed: links.filter((l) => l.status === "Fixed").length,
      closed: links.filter((l) => l.status === "Closed").length,
    };
  });

  const sharedBugs = bugs.filter((bug) => bug.links.length > 1);

  return (
    <main className="page">
      <PageHeader
        id="tab.reporting" path="/reporting" canEdit={editable}
        title="Reporting & defect ledger"
        description="One central reporting surface: report defects, link them to activities and backend services, and let completion progress derive from verified evidence."
        meta={
          <>
            {totals.reported} defects tracked · {bugs.filter((b) => b.links.length > 1).length} shared across services ·
            updated {today}
          </>
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
          <div className="kpi-label">Reported</div>
          <div className="kpi-value">{totals.reported}</div>
          <div className="kpi-foot">across {serviceRows.filter((s) => s.total > 0).length} services</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
          <div className="kpi-label">Fixed</div>
          <div className="kpi-value">{totals.fixed}</div>
          <div className="kpi-foot">awaiting verification</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--good)" }}>
          <div className="kpi-label">Closed</div>
          <div className="kpi-value">{totals.closed}</div>
          <div className="kpi-foot">all service links closed</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--bad)" }}>
          <div className="kpi-label">Outstanding</div>
          <div className="kpi-value">{totals.outstanding}</div>
          <div className="kpi-foot">
            {totals.reported ? Math.round((totals.closed / totals.reported) * 100) : 0}% closure rate
          </div>
        </div>
      </div>

      <PageGuidance id="tab.reporting" path="/reporting" canEdit={editable} />

      <Section
        id="sec.reporting.bugs"
        tabId="tab.reporting"
        title="Bug ledger"
        description="Overall status is derived per service link. One bug can carry one ID across two services — the derived badge shows the true state."
        path="/reporting"
        canEdit={editable}
        bare
      >
        <ReportingBoard
          bugs={bugs.map((bug) => ({
            id: bug.id,
            bug_key: bug.bug_key,
            title: bug.title,
            severity: bug.severity,
            status: bug.status,
            derived_status: bug.derived_status,
            reported_date: bug.reported_date,
            reporter_name: bug.reporter_name,
            activity_id: bug.activity_id,
            activity_name: bug.activity_name,
            notes: bug.notes,
            is_demo: bug.is_demo,
            links: bug.links,
          }))}
          services={services}
          activities={activities.map((a) => ({ id: a.id, activity: a.activity }))}
          canEdit={editable}
          path="/reporting"
        />
      </Section>

      <Section
        id="sec.reporting.progress"
        tabId="tab.reporting"
        title="Activity completion"
        description="Progress is reported, fixed and closed counts against the activity. Manual snapshots override the derived percentage."
        path="/reporting"
        canEdit={editable}
      >
        <div className="card-body stack">
          {completion.map(({ activity, counts }) => {
            const percent = activity.derived_progress;
            return (
              <details key={activity.id} className="card" style={{ padding: "10px 14px" }}>
                <summary style={{ cursor: "pointer", listStyle: "none" }}>
                  <div className="row-between">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>{activity.activity}</div>
                      <div className="card-sub">
                        {activity.assignee_name} · {counts.reported} reported · {counts.fixed} fixed · {counts.closed} closed ·{" "}
                        {counts.outstanding} outstanding
                      </div>
                    </div>
                    <div className="row" style={{ gap: 10, minWidth: 220 }}>
                      <div className={`progress ${percent >= 80 ? "good" : percent < 35 ? "warn" : ""}`} style={{ width: 130 }}>
                        <span style={{ width: `${Math.max(2, percent)}%` }} />
                      </div>
                      <strong style={{ fontVariantNumeric: "tabular-nums", minWidth: 42, textAlign: "right" }}>{percent}%</strong>
                    </div>
                  </div>
                </summary>
                {editable ? (
                  <form action={saveProgressAction} className="inline-form" style={{ marginTop: 12 }}>
                    <input type="hidden" name="activity_id" value={activity.id} />
                    <div className="field">
                      <label>Reported</label>
                      <input className="input input-sm" type="number" name="reported" defaultValue={counts.reported} style={{ width: 80 }} />
                    </div>
                    <div className="field">
                      <label>Fixed</label>
                      <input className="input input-sm" type="number" name="fixed" defaultValue={counts.fixed} style={{ width: 80 }} />
                    </div>
                    <div className="field">
                      <label>Closed</label>
                      <input className="input input-sm" type="number" name="closed" defaultValue={counts.closed} style={{ width: 80 }} />
                    </div>
                    <div className="field">
                      <label>Outstanding</label>
                      <input className="input input-sm" type="number" name="outstanding" defaultValue={counts.outstanding} style={{ width: 90 }} />
                    </div>
                    <div className="field">
                      <label>Completion %</label>
                      <input className="input input-sm" type="number" name="progress_percent" min={0} max={100} defaultValue={percent} style={{ width: 100 }} />
                    </div>
                    <button className="btn btn-sm btn-primary" type="submit">
                      <Icon name="check" size={13} /> Save snapshot
                    </button>
                  </form>
                ) : (
                  <div className="card-sub" style={{ marginTop: 10 }}>Read-only access.</div>
                )}
              </details>
            );
          })}
          {!completion.length ? <div className="empty">No active activities to report against.</div> : null}
        </div>
      </Section>

      <Section
        id="sec.reporting.services"
        tabId="tab.reporting"
        title="Service matrix"
        description="Shared defect IDs appear once per affected service. A bug with one outstanding link is never reported as fixed."
        path="/reporting"
        canEdit={editable}
      >
        <div className="card-body grid-2">
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Links by service</div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th className="num">Links</th>
                    <th className="num">Open</th>
                    <th className="num">Fixed</th>
                    <th className="num">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceRows.map((row) => (
                    <tr key={row.service.id}>
                      <td>
                        {row.service.name}
                        <div className="card-sub">{row.service.application_name}</div>
                      </td>
                      <td className="num">{row.total}</td>
                      <td className="num">{row.open}</td>
                      <td className="num">{row.fixed}</td>
                      <td className="num">{row.closed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Shared defects (multi-service)</div>
            <div className="stack-sm">
              {sharedBugs.map((bug) => (
                <div className="card card-pad" key={bug.id} style={{ padding: 12 }}>
                  <div className="row-between">
                    <strong className="mono" style={{ fontSize: "0.8rem" }}>{bug.bug_key}</strong>
                    <span
                      className={`badge ${
                        bug.derived_status === "Closed" ? "badge-green" : bug.derived_status === "Fixed" ? "badge-blue" : "badge-red"
                      }`}
                    >
                      {bug.derived_status}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.82rem", marginTop: 4 }}>{bug.title}</div>
                  <div className="row" style={{ gap: 4, marginTop: 6 }}>
                    {bug.links.map((link) => (
                      <span
                        key={link.service_id}
                        className={`badge ${
                          link.status === "Closed" ? "badge-green" : link.status === "Fixed" ? "badge-blue" : "badge-red"
                        }`}
                      >
                        {link.service_name} · {link.status}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {!sharedBugs.length ? <div className="empty">No shared defects recorded.</div> : null}
            </div>
            <div className="card-sub" style={{ marginTop: 10 }}>
              {monthLabel(monthStart(today.slice(0, 7)))} · derived statuses recompute on every read, so a late service
              update immediately reopens the defect.
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
