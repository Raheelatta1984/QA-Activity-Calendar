import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { isoToday, formatDate } from "@/lib/dates";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { DecisionForm } from "@/components/DecisionForm";
import { Icon } from "@/components/icons";
import {
  deleteReleaseFeedAction,
  savePquAction,
  saveReleaseFeedAction,
  verifyReleaseLinkAction,
} from "@/app/actions/releases";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const viewer = await getViewer();
  const editable = canEdit(viewer);
  const today = isoToday();
  const settings = appSettings();

  const feed = all<any>(`SELECT * FROM release_feed ORDER BY date DESC, version DESC`);
  const trains = all<any>(`SELECT * FROM pqu_trains ORDER BY COALESCE(change_cutoff, '9999-12-31')`);
  const decisions = all<any>(
    `SELECT g.*, p.name AS decided_by_name FROM release_governance g
      LEFT JOIN people p ON p.id = g.decided_by ORDER BY COALESCE(g.decided_at, '') DESC`
  );
  const plans = all<any>(
    `SELECT s.*, a.name AS application_name FROM service_deployment_plans s
      LEFT JOIN applications a ON a.id = s.application_id ORDER BY s.start_date`
  );
  const departments = viewer.org.departments
    .filter((d) => viewer.departmentIds.has(d.id))
    .map((d) => ({ id: d.id, name: d.name }));

  const goCount = decisions.filter((d) => d.go_no_go === "Go").length;
  const flagged = trains.filter((t) => t.flag);

  return (
    <main className="page">
      <PageHeader
        id="tab.releases" path="/releases" canEdit={editable}
        title="Releases & PQU schedule"
        description="Release feed, PQU release train and audited governance decisions. Planned and actual dates stay separate; unknown values remain unknown."
        meta={
          <>
            {feed.length} feed entries · {trains.length} trains ({flagged.length} flagged) · {decisions.length} decisions
            recorded
          </>
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
          <div className="kpi-label">Releases tracked</div>
          <div className="kpi-value">{feed.length}</div>
          <div className="kpi-foot">{feed.filter((f) => f.kind === "Auto Update").length} auto-update · {feed.filter((f) => f.kind === "Self Update").length} self-update</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--good)" }}>
          <div className="kpi-label">Go decisions</div>
          <div className="kpi-value">{goCount}</div>
          <div className="kpi-foot">each requires regression Passed</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--warn)" }}>
          <div className="kpi-label">PQU flags</div>
          <div className="kpi-value">{flagged.length}</div>
          <div className="kpi-foot">parsed dates flagged for human review</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
          <div className="kpi-label">Deployment plans</div>
          <div className="kpi-value">{plans.length}</div>
          <div className="kpi-foot">WORKDAY.INTL parity: start + weeks×6</div>
        </div>
      </div>

      <PageGuidance id="tab.releases" path="/releases" canEdit={editable} />

      <Section
        id="sec.releases.feed"
        tabId="tab.releases"
        title="Release feed"
        description="Version strings and date-only fields are preserved exactly. Links are never fetched automatically — a human marks them verified."
        path="/releases"
        canEdit={editable}
      >
        <div className="card-pad stack">
          {editable ? (
            <details className="card" style={{ padding: "10px 14px" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
                <Icon name="plus" size={13} /> Add a release entry
              </summary>
              <form action={saveReleaseFeedAction} className="form-grid" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Version</label>
                  <input className="input input-sm" name="version" placeholder="27.4.1" required />
                </div>
                <div className="field">
                  <label>Type</label>
                  <select className="select select-sm" name="kind" defaultValue="Self Update">
                    {["Self Update", "Auto Update", "Manual"].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Date</label>
                  <input className="input input-sm" type="date" name="date" defaultValue={today} />
                </div>
                <div className="field">
                  <label>Department</label>
                  <select className="select select-sm" name="department_id" defaultValue="">
                    <option value="">—</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field span-2">
                  <label>Notes</label>
                  <input className="input input-sm" name="notes" />
                </div>
                <div className="field span-2">
                  <label>Link (optional)</label>
                  <input className="input input-sm" name="link" placeholder="https://" />
                </div>
                <div className="form-actions span-2">
                  <button className="btn btn-sm btn-primary" type="submit">Add entry</button>
                </div>
              </form>
            </details>
          ) : null}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Notes</th>
                  <th>Link</th>
                  {editable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {feed.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.version}</td>
                    <td>
                      <span className={`badge ${entry.kind === "Auto Update" ? "badge-purple" : "badge-blue"}`}>{entry.kind}</span>
                    </td>
                    <td className="mono nowrap">{entry.date ?? "—"}</td>
                    <td className="muted">{entry.notes ?? "—"}</td>
                    <td>
                      {entry.link ? (
                        <span className="row" style={{ gap: 6 }}>
                          <span className={`badge ${entry.link_verified ? "badge-green" : "badge-amber"}`}>
                            {entry.link_verified ? "verified" : "unverified"}
                          </span>
                          {editable && !entry.link_verified ? (
                            <form action={verifyReleaseLinkAction}>
                              <input type="hidden" name="id" value={entry.id} />
                              <button className="btn btn-sm btn-ghost" type="submit">Mark verified</button>
                            </form>
                          ) : null}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {editable ? (
                      <td className="right">
                        <form action={deleteReleaseFeedAction}>
                          <input type="hidden" name="id" value={entry.id} />
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
        </div>
      </Section>

      <Section
        id="sec.releases.pqu"
        tabId="tab.releases"
        title="PQU schedule"
        description="Release train, change cutoff, duration and platform versions. Suspicious chronology is flagged, never silently corrected."
        path="/releases"
        canEdit={editable}
      >
        <div className="card-pad stack">
          {editable ? (
            <details className="card" style={{ padding: "10px 14px" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
                <Icon name="plus" size={13} /> Add a PQU train
              </summary>
              <form action={savePquAction} className="form-grid" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Train</label>
                  <input className="input input-sm" name="train" placeholder="PQU 28.2" required />
                </div>
                <div className="field">
                  <label>Change cutoff</label>
                  <input className="input input-sm" type="date" name="change_cutoff" />
                </div>
                <div className="field">
                  <label>Duration (days)</label>
                  <input className="input input-sm" type="number" name="duration_days" min={1} defaultValue={14} />
                </div>
                <div className="field">
                  <label>Status</label>
                  <select className="select select-sm" name="status" defaultValue="Planned">
                    {["Planned", "In progress", "Complete", "Cancelled"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Application version</label>
                  <input className="input input-sm" name="app_version" />
                </div>
                <div className="field">
                  <label>Platform version</label>
                  <input className="input input-sm" name="platform_version" />
                </div>
                <div className="field span-2">
                  <label>Raw source text</label>
                  <input className="input input-sm" name="date_text_raw" placeholder="Preserved exactly as supplied" />
                </div>
                <div className="form-actions span-2">
                  <button className="btn btn-sm btn-primary" type="submit">Add train</button>
                </div>
              </form>
            </details>
          ) : null}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Train</th>
                  <th>Change cutoff</th>
                  <th className="num">Duration</th>
                  <th>Status</th>
                  <th>App version</th>
                  <th>Platform</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {trains.map((train) => (
                  <tr key={train.id}>
                    <td><strong>{train.train}</strong></td>
                    <td className="mono nowrap">{train.change_cutoff ?? "—"}</td>
                    <td className="num">{train.duration_days ?? "—"}d</td>
                    <td>
                      <span className={`badge ${train.status === "Complete" ? "badge-green" : train.status === "In progress" ? "badge-blue" : "badge-slate"}`}>
                        {train.status}
                      </span>
                    </td>
                    <td className="mono">{train.app_version ?? "—"}</td>
                    <td className="mono">{train.platform_version ?? "—"}</td>
                    <td>
                      {train.flag ? (
                        <span className="badge badge-amber" title={train.flag}><Icon name="alert" size={11} /> review</span>
                      ) : (
                        <span className="badge badge-green">clear</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-sub">
            Parsed date ranges keep the original text ({trains.filter((t) => t.date_text_raw).length} rows) so a reviewer can
            verify the interpretation. Workdays follow the NSW calendar; durations are calendar days.
          </div>
        </div>
      </Section>

      <Section
        id="sec.releases.governance"
        tabId="tab.releases"
        title="Release governance"
        description="Regression status, go/no-go and deployment status form an audited decision. Go is blocked unless regression has passed."
        path="/releases"
        canEdit={editable}
      >
        <div className="card-pad stack">
          {editable ? <DecisionForm versions={[...new Set(feed.map((f) => f.version))]} today={today} /> : null}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Regression</th>
                  <th>Decision</th>
                  <th>Deployment</th>
                  <th>Decided by</th>
                  <th>Decided at</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td className="mono">{decision.version}</td>
                    <td>
                      <span className={`badge ${decision.regression_status === "Passed" ? "badge-green" : decision.regression_status === "Failed" ? "badge-red" : "badge-slate"}`}>
                        {decision.regression_status}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${decision.go_no_go === "Go" ? "badge-green" : decision.go_no_go === "No-Go" ? "badge-red" : "badge-amber"}`}>
                        {decision.go_no_go}
                      </span>
                    </td>
                    <td className="muted">{decision.deployment_status}</td>
                    <td className="muted">{decision.decided_by_name ?? "—"}</td>
                    <td className="mono nowrap">{decision.decided_at ?? "—"}</td>
                    <td className="muted">{decision.notes ?? "—"}</td>
                  </tr>
                ))}
                {!decisions.length ? (
                  <tr>
                    <td colSpan={7}><div className="empty">No decisions recorded yet.</div></td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div>
            <div className="label" style={{ marginBottom: 6 }}>Service deployment plans (source formula parity)</div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Service</th>
                    <th>Start</th>
                    <th className="num">Weeks</th>
                    <th>Planned</th>
                    <th>Actual</th>
                    <th>Override</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((plan) => (
                    <tr key={plan.id}>
                      <td>{plan.application_name ?? "—"}</td>
                      <td>{plan.service ?? "—"}</td>
                      <td className="mono">{plan.start_date ?? "—"}</td>
                      <td className="num">{plan.weeks ?? "—"}</td>
                      <td className="mono">{plan.planned_date ?? "—"}</td>
                      <td className="mono">{plan.actual_date ?? "—"}</td>
                      <td className="mono">{plan.manual_override_date ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-sub" style={{ marginTop: 6 }}>
              Formula: start + weeks × 6, then workday adjustment (fiscal weekends and manual overrides). As of{" "}
              {formatDate(today)} with {settings.timezone}.
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
