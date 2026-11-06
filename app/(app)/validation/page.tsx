import Link from "next/link";
import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { RULE_CATALOGUE, validationSummary } from "@/lib/validation";
import { isoToday } from "@/lib/dates";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { Icon } from "@/components/icons";
import { runValidationAction, setIssueStatusAction } from "@/app/actions/validation";
import { recentAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const SEVERITY_BADGE: Record<string, string> = {
  error: "badge-red",
  warning: "badge-amber",
  info: "badge-blue",
};

export default async function ValidationPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string; status?: string }>;
}) {
  const viewer = await getViewer();
  const editable = canEdit(viewer);
  const params = await searchParams;
  const severity = params.severity ?? "all";
  const status = params.status ?? "open";

  const issues = all<any>(
    `SELECT * FROM validation_issues
      WHERE (? = 'all' OR severity = ?) AND (? = 'all' OR status = ?)
      ORDER BY CASE severity WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, last_seen DESC
      LIMIT 400`,
    severity,
    severity,
    status,
    status
  );
  const summary = validationSummary();
  const resolved = all<{ n: number }>(`SELECT COUNT(*) AS n FROM validation_issues WHERE status = 'resolved'`)[0]?.n ?? 0;
  const audit = recentAudit(12);

  return (
    <main className="page">
      <PageHeader
        id="tab.validation" path="/validation" canEdit={editable}
        title="Data quality & validation"
        description="Documented rule catalogue with a live queue. Errors block reporting, warnings need a decision, info is informational. Re-running is idempotent."
        meta={<>Last scan {isoToday()} · {issues.length} issues in this view · {resolved} resolved historically</>}
        action={
          editable ? (
            <form action={runValidationAction}>
              <button className="btn btn-primary" type="submit">
                <Icon name="refresh" size={15} /> Re-run checks
              </button>
            </form>
          ) : null
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--bad)" }}>
          <div className="kpi-label">Errors</div>
          <div className="kpi-value">{summary.error}</div>
          <div className="kpi-foot">block reporting until resolved</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--warn)" }}>
          <div className="kpi-label">Warnings</div>
          <div className="kpi-value">{summary.warning}</div>
          <div className="kpi-foot">needs a decision</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
          <div className="kpi-label">Info</div>
          <div className="kpi-value">{summary.info}</div>
          <div className="kpi-foot">context, no action strictly required</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--good)" }}>
          <div className="kpi-label">Resolved</div>
          <div className="kpi-value">{resolved}</div>
          <div className="kpi-foot">cleared by a later scan</div>
        </div>
      </div>

      <PageGuidance id="tab.validation" path="/validation" canEdit={editable} />

      <Section
        id="sec.validation.issues"
        tabId="tab.validation"
        title="Validation queue"
        description="Missing dates, invalid ranges, duplicates, conflicts, orphaned records and suspect chronology. Unknown data stays unknown."
        path="/validation"
        canEdit={editable}
      >
        <div className="card-pad stack">
          <div className="filters">
            {["all", "error", "warning", "info"].map((s) => (
              <Link
                key={s}
                href={`/validation?severity=${s}&status=${status}`}
                className={`btn btn-sm ${severity === s ? "btn-primary" : ""}`}
              >
                {s === "all" ? "All severities" : s}
              </Link>
            ))}
            <span style={{ width: 1, background: "var(--border)", height: 24 }} />
            {["open", "acknowledged", "resolved", "all"].map((s) => (
              <Link
                key={s}
                href={`/validation?severity=${severity}&status=${s}`}
                className={`btn btn-sm ${status === s ? "" : "btn-ghost"}`}
              >
                {s}
              </Link>
            ))}
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Rule</th>
                  <th>Entity</th>
                  <th>Message</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  {editable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr key={issue.id}>
                    <td>
                      <span className={`badge ${SEVERITY_BADGE[issue.severity] ?? "badge-slate"}`}>{issue.severity}</span>
                    </td>
                    <td className="mono" style={{ fontSize: "0.7rem" }}>{issue.rule}</td>
                    <td className="muted">{issue.entity}</td>
                    <td style={{ maxWidth: 520 }}>{issue.message}</td>
                    <td>
                      <span className={`badge ${issue.status === "resolved" ? "badge-green" : issue.status === "acknowledged" ? "badge-blue" : "badge-slate"}`}>
                        {issue.status}
                      </span>
                    </td>
                    <td className="mono nowrap">{String(issue.last_seen).slice(0, 16)}</td>
                    {editable ? (
                      <td className="right nowrap">
                        {issue.status !== "acknowledged" ? (
                          <form action={setIssueStatusAction} style={{ display: "inline" }}>
                            <input type="hidden" name="id" value={issue.id} />
                            <input type="hidden" name="status" value="acknowledged" />
                            <button className="btn btn-sm btn-ghost" type="submit">Acknowledge</button>
                          </form>
                        ) : null}
                        {issue.status !== "resolved" ? (
                          <form action={setIssueStatusAction} style={{ display: "inline" }}>
                            <input type="hidden" name="id" value={issue.id} />
                            <input type="hidden" name="status" value="resolved" />
                            <button className="btn btn-sm btn-ghost" type="submit">Resolve</button>
                          </form>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
                {!issues.length ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty">No issues in this view. Re-run the checks after an import.</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section
        id="sec.validation.rules"
        tabId="tab.validation"
        title="Rule catalogue"
        description="Every rule documents its parity decision so a reviewer can justify the behaviour."
        path="/validation"
        canEdit={editable}
      >
        <div className="card-pad grid-2">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Severity</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {RULE_CATALOGUE.map((rule) => (
                  <tr key={rule.rule}>
                    <td className="mono" style={{ fontSize: "0.7rem" }}>{rule.rule}</td>
                    <td>
                      <span className={`badge ${SEVERITY_BADGE[rule.severity] ?? "badge-slate"}`}>{rule.severity}</span>
                    </td>
                    <td className="muted">{rule.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Recent audit trail</div>
            <div className="stack-sm">
              {audit.map((event) => (
                <div key={event.id} className="row-between" style={{ fontSize: "0.78rem" }}>
                  <span>
                    <strong>{event.actor_name ?? "system"}</strong>{" "}
                    <span className="muted">
                      {event.action} · {event.entity}
                    </span>
                  </span>
                  <span className="mono muted">{String(event.at).slice(5, 16)}</span>
                </div>
              ))}
              {!audit.length ? <div className="empty">No audit events yet.</div> : null}
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
