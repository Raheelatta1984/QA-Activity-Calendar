import Link from "next/link";
import { getViewer, canEdit } from "@/lib/access";
import { fteCalendar, activityGroups, quarterOfMonth, type FteRange } from "@/lib/fte";
import { addMonths, fiscalQuarters, fiscalYearOf, isoToday, monthLabel, monthStart } from "@/lib/dates";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { FteCalendarBoard } from "@/components/FteCalendarBoard";
import { FteScopeBar } from "@/components/FteScopeBar";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function FtePage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    month?: string;
    quarter?: string;
    dept?: string;
    group?: string;
    assignee?: string;
    testing?: string;
    releases?: string;
    q?: string;
  }>;
}) {
  const viewer = await getViewer();
  const settings = appSettings();
  const params = await searchParams;
  const today = isoToday();

  const range: FteRange = params.range === "quarter" ? "quarter" : "month";
  const monthKey = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : today.slice(0, 7);
  const quarterRaw = Number(params.quarter);
  const quarter = quarterRaw >= 1 && quarterRaw <= 4 ? quarterRaw : quarterOfMonth(monthKey, settings.fiscalStartMonth);

  const calendar = fteCalendar(viewer, {
    range,
    monthKey,
    quarter,
    departmentId: params.dept || null,
    group: params.group || null,
    assigneeId: params.assignee || null,
    testingOnly: params.testing !== "0",
    includeReleases: params.releases !== "0",
    search: params.q ?? "",
  });

  const releasesIncluded = params.releases !== "0";

  const monthOptions = Array.from({ length: 15 }, (_, i) => {
    const key = addMonths(`${today.slice(0, 7)}-01`, i - 6).slice(0, 7);
    return { key, label: monthLabel(monthStart(key)) };
  });
  const fy = fiscalYearOf(monthKey, settings.fiscalStartMonth);
  const quarterOptions = fiscalQuarters(fy.startYear, settings.fiscalStartMonth).map((q) => ({
    value: q.quarter,
    label: `Q${q.quarter} · ${monthLabel(q.start).split(" ")[0]} – ${monthLabel(q.end).split(" ")[0]}`,
  }));

  const departments = viewer.org.departments
    .filter((d) => viewer.departmentIds.has(d.id) && d.enabled)
    .map((d) => ({ id: d.id, name: d.name }));
  const people = viewer.org.people
    .filter((p) => !!p.active)
    .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
    .filter((p) => !calendar.scope.department_id || p.department_id === calendar.scope.department_id)
    .map((p) => ({ id: p.id, name: p.name }));

  const totals = calendar.totals;
  const gap = totals.variance_fte_days;
  const gapBadge = gap >= 0 ? "badge-green" : gap > -totals.headcount ? "badge-amber" : "badge-red";
  const peak = Math.max(totals.peak_fte, totals.headcount, 1);
  const workingDemand = calendar.days
    .map((day, index) => ({ day, fte: calendar.daily_totals[index] }))
    .filter((entry) => entry.day.working);

  return (
    <main className="page">
      <PageHeader
        id="tab.fte"
        path="/fte"
        canEdit={canEdit(viewer)}
        title="FTE calendar by activity"
        description="Planned activity × day FTE demand for the QA department, with a total per activity and per day. Compare the daily total against the people available to decide where to add, move or re-sequence testing resource."
        meta={
          <>
            {calendar.label} · {totals.activities} testing activit{totals.activities === 1 ? "y" : "ies"} ·{" "}
            {releasesIncluded ? `${totals.releases} release window${totals.releases === 1 ? "" : "s"} · ` : ""}
            {totals.working_days} working days · {calendar.scope.department_name}
            {calendar.scope.testing_only ? " · testing activity only" : ""}
          </>
        }
        action={
          <Link className="btn btn-sm" href="/capacity">
            <Icon name="activity" size={13} /> Capacity planner
          </Link>
        }
      />

      <PageGuidance id="tab.fte" path="/fte" canEdit={canEdit(viewer)} />

      <Section
        id="sec.fte.filters"
        tabId="tab.fte"
        title="Scope"
        description="Period, department, activity group, assignee and search. Defaults to the QA department and testing activities (recording/pipeline excluded)."
        path="/fte"
        canEdit={canEdit(viewer)}
        bare
      >
        <FteScopeBar
          range={range}
          monthKey={monthKey}
          quarter={quarter}
          monthOptions={monthOptions}
          quarterOptions={quarterOptions}
          departments={departments}
          departmentId={calendar.scope.department_id}
          groups={activityGroups(viewer.org.company.id)}
          group={calendar.scope.group}
          people={people}
          assigneeId={calendar.scope.assignee_id}
          testingOnly={calendar.scope.testing_only}
          releasesIncluded={releasesIncluded}
          search={calendar.scope.search}
        />
      </Section>

      <Section
        id="sec.fte.summary"
        tabId="tab.fte"
        title="FTE required vs people available"
        description="Demand is the sum of effective FTE for every active testing activity that spans each working day. Supply is the team headcount for the period, less recorded leave and DevOps time from the capacity planner."
        path="/fte"
        canEdit={canEdit(viewer)}
      >
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
            <div className="kpi-label">FTE demand</div>
            <div className="kpi-value">
              {totals.fte_days_working}
              <small>FTE-days</small>
            </div>
            <div className="kpi-foot">
              {totals.avg_daily_fte} FTE per working day · {totals.hours}h at {calendar.hoursPerDay}h/day
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
            <div className="kpi-label">Busiest day</div>
            <div className="kpi-value">
              {totals.peak_fte}
              <small>FTE</small>
            </div>
            <div className="kpi-foot">
              {totals.peak_dates.length ? totals.peak_dates.slice(0, 3).join(", ") : "no demand scheduled"}
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--accent)" }}>
            <div className="kpi-label">People available</div>
            <div className="kpi-value">
              {totals.headcount}
              <small>people</small>
            </div>
            <div className="kpi-foot">
              {totals.supply_fte_days} FTE-days after {totals.unavailable_fte_days} FTE-days leave/DevOps
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: gap >= 0 ? "var(--good)" : "var(--bad)" }}>
            <div className="kpi-label">Resourcing gap</div>
            <div className="kpi-value">
              {gap}
              <small>FTE-days</small>
            </div>
            <div className="kpi-foot">
              {gap >= 0
                ? `${gap} FTE-days spare — pull work forward or backfill leave`
                : `${Math.abs(gap)} FTE-days short — add contractor cover or re-sequence`}
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: totals.over_days.length ? "var(--bad)" : "var(--good)" }}>
            <div className="kpi-label">Over-allocated days</div>
            <div className="kpi-value">{totals.over_days.length}</div>
            <div className="kpi-foot">
              {totals.over_days.length
                ? totals.over_days.slice(0, 3).map((d) => `${d.date.slice(5)} (${d.fte})`).join(", ")
                : `within ${totals.headcount} available people`}
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
            <div className="kpi-label">Release QA demand</div>
            <div className="kpi-value">
              {totals.release_fte_days}
              <small>FTE-days</small>
            </div>
            <div className="kpi-foot">
              {releasesIncluded
                ? `${totals.releases} release window${totals.releases === 1 ? "" : "s"} merged from the Releases tab`
                : "release windows excluded from this view"}
            </div>
          </div>
          <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--accent)" }}>
            <div className="kpi-label">Headcount to cover</div>
            <div className="kpi-value">
              {totals.required_headcount_peak}
              <small>people</small>
            </div>
            <div className="kpi-foot">
              peak day · {totals.required_headcount_avg} FTE on an average day
              {totals.unscheduled ? ` · ${totals.unscheduled} unscheduled record(s) excluded` : ""}
            </div>
          </div>
        </div>

        <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="label" style={{ marginBottom: 8 }}>
            FTE demand per working day
          </div>
          <div className="bar-chart" style={{ height: 130 }}>
            {workingDemand.map(({ day, fte }) => (
              <div className="bar-col" key={day.date} title={`${day.date}: ${fte} FTE`}>
                <div className="bar-label">{fte || ""}</div>
                <div
                  className="bar"
                  style={{
                    height: `${Math.max(2, (fte / peak) * 100)}%`,
                    background:
                      totals.headcount > 0 && fte > totals.headcount
                        ? "linear-gradient(180deg, var(--bad), #b91c1c)"
                        : undefined,
                  }}
                />
                <div className="bar-label">
                  {day.weekdayShort} {day.day}
                </div>
              </div>
            ))}
          </div>
          <div className="row-between" style={{ marginTop: 10 }}>
            <span className="card-sub">
              Red bars exceed the {totals.headcount} people available in {calendar.scope.department_name}. Blank days
              mean nothing is planned — not that the team is free of other work.
            </span>
            <span className={`badge ${gapBadge}`}>
              {gap >= 0 ? `${gap} FTE-days spare` : `${Math.abs(gap)} FTE-days short`}
            </span>
          </div>
        </div>
      </Section>

      <Section
        id="sec.fte.grid"
        tabId="tab.fte"
        title="Activity × day FTE matrix"
        description="One row per testing activity, one column per day, with a total per activity and a daily total row. Switch between FTE and hours, hide weekends and holidays, or focus a single activity group."
        path="/fte"
        canEdit={canEdit(viewer)}
        bare
      >
        <FteCalendarBoard
          days={calendar.days.map((d) => ({
            date: d.date,
            day: d.day,
            weekdayShort: d.weekdayShort,
            working: d.working,
            holiday: d.holiday,
            isToday: d.isToday,
            isWeekend: d.isWeekend,
          }))}
          rows={calendar.rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            href: row.href,
            code: row.code,
            activity: row.activity,
            detail: row.detail,
            group: row.group,
            colour: row.colour,
            status: row.status,
            priority: row.priority,
            department_name: row.department_name,
            assignee_name: row.assignee_name,
            start_date: row.start_date,
            end_date: row.end_date,
            effective_fte: row.effective_fte,
            derived_progress: row.derived_progress,
            cells: row.cells,
            total_fte_days: row.total_fte_days,
            total_fte_working: row.total_fte_working,
            covered_days: row.covered_days,
          }))}
          dailyTotals={calendar.daily_totals}
          dailyActivityCounts={calendar.daily_activity_counts}
          hoursPerDay={calendar.hoursPerDay}
          headcount={totals.headcount}
          departmentName={calendar.scope.department_name}
          label={calendar.label}
          canEdit={canEdit(viewer)}
        />
      </Section>

      <Section
        id="sec.fte.resources"
        tabId="tab.fte"
        title="Who is carrying the load"
        description="FTE allocated per person across the period, averaged over working days. A person above 1.0 on any day is over-committed; the variance column shows where to move work."
        path="/fte"
        canEdit={canEdit(viewer)}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role / title</th>
                <th className="num">Activities</th>
                <th className="num">FTE-days</th>
                <th className="num">Avg FTE/day</th>
                <th className="num">Peak FTE</th>
                <th>Load</th>
                <th className="num">Variance</th>
              </tr>
            </thead>
            <tbody>
              {calendar.by_assignee.map((person) => {
                const over = person.variance_fte < 0;
                const pct = Math.min(150, Math.round(person.avg_fte * 100));
                return (
                  <tr key={person.person_id ?? person.name}>
                    <td>
                      <span className="row" style={{ gap: 7 }}>
                        <span
                          className="avatar"
                          style={{ width: 22, height: 22, flex: "0 0 22px", background: person.colour, fontSize: "0.6rem" }}
                        >
                          {person.name
                            .split(" ")
                            .map((p) => p[0])
                            .slice(0, 2)
                            .join("")}
                        </span>
                        {person.name}
                      </span>
                    </td>
                    <td className="muted">{person.title ?? "—"}</td>
                    <td className="num">{person.activities}</td>
                    <td className="num">{person.fte_days}</td>
                    <td className="num">{person.avg_fte}</td>
                    <td className="num">
                      {person.peak_fte}
                      {person.peak_date ? (
                        <span className="muted" style={{ fontSize: "0.7rem" }}>
                          {" "}
                          ({person.peak_date.slice(5)})
                        </span>
                      ) : null}
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <div className="progress" style={{ height: 6 }}>
                        <span
                          className={over ? "bad" : pct > 85 ? "warn" : "good"}
                          style={{ width: `${Math.min(100, pct)}%`, display: "block", height: "100%", borderRadius: 999 }}
                        />
                      </div>
                    </td>
                    <td className="num">
                      <span className={`badge ${over ? "badge-red" : person.variance_fte < 0.25 ? "badge-amber" : "badge-green"}`}>
                        {person.variance_fte >= 0 ? `${person.variance_fte} spare` : `${Math.abs(person.variance_fte)} over`}
                      </span>
                      {person.over_days ? (
                        <div className="card-sub" style={{ fontSize: "0.66rem" }}>
                          {person.over_days} day{person.over_days === 1 ? "" : "s"} above 1.0
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!calendar.by_assignee.length ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No testing activity in this scope — widen the filters above.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Demand by activity group
          </div>
          <div className="fte-bar">
            {calendar.by_group.map((group) => (
              <div className="fte-bar-row" key={group.group}>
                <span>
                  <span className="legend-swatch" style={{ background: group.colour }} /> {group.group}
                </span>
                <span className="fte-bar-track">
                  <span className="fte-bar-fill" style={{ width: `${Math.max(2, group.share)}%` }} />
                </span>
                <span className="num">
                  {group.fte_days} FTE-days · {group.share}%
                </span>
              </div>
            ))}
            {!calendar.by_group.length ? <div className="card-sub">No demand in this scope.</div> : null}
          </div>
        </div>

        {totals.unscheduled ? (
          <div className="banner warn" style={{ marginTop: 16 }}>
            <Icon name="alert" size={15} />
            <span>
              {totals.unscheduled} active record{totals.unscheduled === 1 ? "" : "s"} in this department have no valid
              date range, so no FTE can be planned for {totals.unscheduled === 1 ? "it" : "them"}. Fix the dates in the{" "}
              <Link href="/validation">Data Quality</Link> queue to bring {totals.unscheduled === 1 ? "it" : "them"} into
              this calendar.
            </span>
          </div>
        ) : null}
      </Section>
    </main>
  );
}
