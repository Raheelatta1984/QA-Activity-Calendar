import Link from "next/link";
import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { activitySummary, listActivities } from "@/lib/activities";
import { capacityMonth, capacityTrend } from "@/lib/capacity";
import { listPipeline, pipelineStats } from "@/lib/pipeline";
import { bugTotals, listBugs } from "@/lib/bugs";
import { dashboardInsights, aiStatus } from "@/lib/ai";
import { appSettings } from "@/lib/settings";
import { addMonths, isoToday, monthLabel, monthStart, addDays } from "@/lib/dates";
import { validationSummary } from "@/lib/validation";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { Icon } from "@/components/icons";
import { DashboardActions } from "@/components/DashboardActions";
import { toClientActivity } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const SEVERITY_STYLES: Record<string, { colour: string; icon: string; badge: string }> = {
  critical: { colour: "var(--bad)", icon: "alert", badge: "badge-red" },
  warning: { colour: "var(--warn)", icon: "alert", badge: "badge-amber" },
  good: { colour: "var(--good)", icon: "check", badge: "badge-green" },
  info: { colour: "var(--brand)", icon: "info", badge: "badge-blue" },
};

export default async function DashboardPage() {
  const viewer = await getViewer();
  const settings = appSettings();
  const today = isoToday();
  const monthKey = today.slice(0, 7);
  const month = capacityMonth(viewer, monthKey);
  const summary = activitySummary(viewer, month.start, month.end);
  const pipeline = listPipeline(viewer);
  const pipelineSummary = pipelineStats(pipeline);
  const bugs = listBugs(viewer);
  const totals = bugTotals(bugs);
  const insights = dashboardInsights(viewer, monthKey);
  const issues = validationSummary();
  const trend = capacityTrend(viewer, 4);
  const ai = aiStatus();

  const activeActivities = summary.activities.filter((a) => a.active === 1);
  const perPerson = viewer.org.people
    .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
    .filter((p) => !!p.active)
    .map((person) => {
      const own = activeActivities.filter((a) => a.assignee_id === person.id);
      const progress = own.length
        ? Math.round(own.reduce((s, a) => s + a.derived_progress, 0) / own.length)
        : 0;
      const capacity = month.people.find((c) => c.person_id === person.id);
      return {
        person,
        count: own.length,
        progress,
        inProgress: own.filter((a) => a.status === "In Progress").length,
        blocked: own.filter((a) => a.status === "Blocked").length,
        complete: own.filter((a) => a.status === "Complete").length,
        fte: Math.round(own.reduce((s, a) => s + a.effective_fte, 0) * 10) / 10,
        utilisation: capacity?.utilisation ?? 0,
        hours: capacity?.total_hours ?? 0,
        over: capacity?.over_allocated_days.length ?? 0,
      };
    })
    .filter((row) => row.count > 0 || row.utilisation > 0)
    .sort((a, b) => b.progress - a.progress);

  const nextSeven = summary.activities.filter(
    (a) => a.active && a.start_date && a.start_date >= today && a.start_date <= addDays(today, 7)
  );

  return (
    <main className="page">
      <PageHeader
        id="tab.dashboard" path="/" canEdit={canEdit(viewer)}
        title={`Good day, ${viewer.actingAs.name.split(" ")[0]}`}
        description={`Progress, capacity and pipeline signals for ${monthLabel(monthStart(monthKey))}. Scope: ${
          viewer.canSeeAll ? "holistic view — all enabled departments" : `${viewer.personIds.size} people in your reporting tree`
        }.`}
        meta={
          <>
            Fiscal {settings.fiscalStartMonth === 7 ? "year starts in July" : `year starts in month ${settings.fiscalStartMonth}`} ·{" "}
            {month.totals.working_days} working days this month · AI provider: {ai.provider}
          </>
        }
        action={
          <DashboardActions
            activities={activeActivities.slice(0, 40).map(toClientActivity)}
            people={viewer.org.people
              .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
              .map((p) => ({
                id: p.id,
                name: p.name,
                role: p.role,
                title: p.title,
                colour: p.colour,
                department_id: p.department_id,
                manager_id: p.manager_id,
              }))}
            departments={viewer.org.departments
              .filter((d) => viewer.departmentIds.has(d.id))
              .map((d) => ({ id: d.id, name: d.name, colour: d.colour, enabled: d.enabled }))}
            canEdit={canEdit(viewer)}
          />
        }
      />

      <PageGuidance id="tab.dashboard" path="/" canEdit={canEdit(viewer)} />

      <Section
        id="sec.dashboard.kpis"
        tabId="tab.dashboard"
        title="Headline KPIs"
        description="Active activities only, within the current fiscal month. FTE demand and occupied capacity are separate metrics by design."
        path="/"
        canEdit={canEdit(viewer)}
        bare
      >
        <div className="kpi-grid">
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
            <div className="kpi-label">Active activities</div>
            <div className="kpi-value">
              {summary.activeCount}
              {summary.unscheduled ? <small>{summary.unscheduled} unscheduled</small> : null}
            </div>
            <div className="kpi-foot">
              {summary.byStatus["In Progress"] ?? 0} in progress · {summary.byStatus["Blocked"] ?? 0} blocked
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
            <div className="kpi-label">FTE demand</div>
            <div className="kpi-value">
              {summary.fteDemand}
              <small>FTE</small>
            </div>
            <div className="kpi-foot">
              against {month.people.length} people · {month.totals.working_days} working days
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--accent)" }}>
            <div className="kpi-label">Occupied capacity</div>
            <div className="kpi-value">
              {month.totals.utilisation}
              <small>%</small>
            </div>
            <div className="kpi-foot">
              {month.totals.occupied}h occupied of {month.totals.total_hours}h total
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--good)" }}>
            <div className="kpi-label">Average completion</div>
            <div className="kpi-value">
              {summary.avgProgress}
              <small>%</small>
            </div>
            <div className="kpi-foot">{summary.activeCount ? "across active activities" : "no active work this month"}</div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--bad)" }}>
            <div className="kpi-label">Outstanding defects</div>
            <div className="kpi-value">
              {totals.outstanding}
              <small>of {totals.reported}</small>
            </div>
            <div className="kpi-foot">
              {totals.fixed} fixed · {totals.closed} closed
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--warn)" }}>
            <div className="kpi-label">Eligible recording days</div>
            <div className="kpi-value">
              {pipelineSummary.eligible}
              <small>days</small>
            </div>
            <div className="kpi-foot">
              {pipelineSummary.blocked} blocked · {pipelineSummary.test} TEST records excluded
            </div>
          </div>
        </div>

        {issues.error ? (
          <div className="banner bad" style={{ marginTop: 14 }}>
            <Icon name="alert" size={15} />
            <span>
              {issues.error} blocking data-quality issue{issues.error === 1 ? "" : "s"} need attention before reporting
              is reliable.
            </span>
            <Link className="btn btn-sm" href="/validation">
              Open queue
            </Link>
          </div>
        ) : null}
      </Section>

      <div className="grid-side">
        <Section
          id="sec.dashboard.progress"
          tabId="tab.dashboard"
          title="Progress by assignee"
          description="Completion is derived from linked bugs (closed = 100%, fixed = 75%) unless a manual percentage is set."
          path="/"
          canEdit={canEdit(viewer)}
        >
          <div className="card-body stack-sm">
            {perPerson.length ? (
              perPerson.map((row) => (
                <div className="progress-row" key={row.person.id}>
                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="avatar" style={{ background: row.person.colour, width: 24, height: 24, flex: "0 0 24px" }}>
                      {row.person.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.person.name}
                    </span>
                  </div>
                  <div>
                    <div className={`progress ${row.progress >= 80 ? "good" : row.progress < 35 ? "warn" : ""}`}>
                      <span style={{ width: `${Math.max(2, row.progress)}%` }} />
                    </div>
                    <div className="card-sub" style={{ marginTop: 3 }}>
                      {row.count} activities · {row.fte} FTE · {row.inProgress} in progress
                      {row.blocked ? ` · ${row.blocked} blocked` : ""}
                    </div>
                  </div>
                  <strong style={{ fontVariantNumeric: "tabular-nums" }}>{row.progress}%</strong>
                </div>
              ))
            ) : (
              <div className="empty">No activities in scope for this month.</div>
            )}
          </div>
        </Section>

        <Section
          id="sec.dashboard.capacity"
          tabId="tab.dashboard"
          title="Capacity by assignee"
          description="Occupied = unavailable + DevOps + recording + QA hours. It is not productive utilisation."
          path="/"
          canEdit={canEdit(viewer)}
        >
          <div className="card-body" style={{ display: "grid", gap: 12 }}>
            {month.people.length ? (
              month.people.map((person) => (
                <div key={person.person_id}>
                  <div className="row-between" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>{person.name}</span>
                    <span className="card-sub">
                      {person.occupied}h / {person.total_hours}h
                      {person.over_allocated_days.length ? (
                        <span className="badge badge-red" style={{ marginLeft: 6 }}>
                          FTE &gt; 1
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className={`progress ${person.utilisation > 100 ? "bad" : person.utilisation > 90 ? "warn" : "good"}`}>
                    <span style={{ width: `${Math.min(100, person.utilisation)}%` }} />
                  </div>
                  <div className="card-sub" style={{ marginTop: 3 }}>
                    {person.utilisation}% occupied · {person.qa_testing}h QA · {person.not_available}h unavailable ·{" "}
                    {person.devops}h DevOps
                  </div>
                </div>
              ))
            ) : (
              <div className="empty">No people in the current scope.</div>
            )}
            <Link className="btn btn-sm" href="/capacity" style={{ justifySelf: "start" }}>
              Open capacity planner <Icon name="chevronRight" size={13} />
            </Link>
          </div>
        </Section>
      </div>

      <Section
        id="sec.dashboard.ai"
        tabId="tab.dashboard"
        title="AI insights"
        description={`${ai.note} Model: ${ai.model}.`}
        path="/"
        canEdit={canEdit(viewer)}
      >
        <div className="card-body">
          {insights.map((insight) => {
            const style = SEVERITY_STYLES[insight.severity];
            return (
              <div className="insight" key={insight.id} style={{ ["--insight" as string]: style.colour }}>
                <div className="insight-icon">
                  <Icon name={style.icon} size={15} />
                </div>
                <div className="grow">
                  <div className="row-between">
                    <div className="insight-title">{insight.title}</div>
                    <span className={`badge ${style.badge}`}>{insight.severity}</span>
                  </div>
                  <div className="insight-detail">{insight.detail}</div>
                  {insight.evidence.length ? (
                    <ul className="insight-evidence">
                      {insight.evidence.slice(0, 5).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {insight.href ? (
                    <Link href={insight.href} className="btn btn-sm btn-ghost" style={{ marginTop: 6, paddingLeft: 0 }}>
                      Investigate <Icon name="chevronRight" size={12} />
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="grid-2">
        <Section
          id="sec.dashboard.upcoming"
          tabId="tab.dashboard"
          title="Starting in the next 7 days"
          description="Planned starts only — actuals are recorded from the calendar drawer."
          path="/"
          canEdit={canEdit(viewer)}
        >
          <div className="card-body stack-sm">
            {nextSeven.length ? (
              nextSeven.map((a) => (
                <div className="row-between" key={a.id} style={{ fontSize: "0.83rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.activity}
                    </div>
                    <div className="card-sub">
                      {a.assignee_name} · {a.department_name}
                    </div>
                  </div>
                  <span className="badge badge-slate">{a.start_date}</span>
                </div>
              ))
            ) : (
              <div className="empty">Nothing scheduled to start in the next week.</div>
            )}
          </div>
        </Section>

        <Section
          id="sec.dashboard.trend"
          tabId="tab.dashboard"
          title="Occupied capacity trend"
          description="Four-month view. Hover a bar for the underlying hours."
          path="/"
          canEdit={canEdit(viewer)}
        >
          <div className="card-body">
            <div className="bar-chart">
              {trend.map((t) => (
                <div className="bar-col" key={t.monthKey} title={`${t.label}: ${t.utilisation}% of ${t.hours}h, ${t.fte} FTE`}>
                  <div className="bar-label">{t.utilisation}%</div>
                  <div className="bar" style={{ height: `${Math.min(100, t.utilisation)}%` }} />
                  <div className="bar-label">{t.label}</div>
                </div>
              ))}
            </div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              Bars are percentage of occupied hours, not headcount. Values above 100% are clamped visually and flagged
              in the capacity planner.
            </div>
          </div>
        </Section>
      </div>

      <div className="card-sub" style={{ marginTop: 20 }}>
        Data as of {today} ({settings.timezone}). Previous period:{" "}
        {monthLabel(monthStart(addMonths(`${monthKey}-01`, -1).slice(0, 7)))}. Demo rows are flagged in the database and
        never presented as operational evidence.
      </div>
    </main>
  );
}
