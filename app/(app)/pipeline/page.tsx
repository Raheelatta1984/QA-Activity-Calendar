import { getViewer, canAdmin, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { availabilityWindow, holidayMap, listExclusions, listPipeline, pipelineStats } from "@/lib/pipeline";
import { addDays, addMonths, isoToday, monthLabel, monthStart } from "@/lib/dates";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { PipelineBoard } from "@/components/PipelineBoard";
import { toClientPipeline } from "@/lib/serialize";
import { addExclusionAction, removeExclusionAction } from "@/app/actions/pipeline";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const viewer = await getViewer();
  const today = isoToday();
  const monthKey = today.slice(0, 7);
  const items = listPipeline(viewer);
  const stats = pipelineStats(items);
  const exclusions = listExclusions();
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weekEnd = addDays(weekStart, 6);
  const availability = availabilityWindow(
    monthStart(monthKey),
    addMonths(monthStart(monthKey), 1)
  ).map((day) => ({
    date: day.date,
    day: Number(day.date.slice(8)),
    inMonth: true,
    isWeekend: day.status === "weekend",
    isHoliday: day.status === "holiday",
    holidayName: day.label,
    isToday: day.date === today,
    isCurrentWeek: day.date >= weekStart && day.date <= weekEnd,
  }));

  const people = viewer.org.people
    .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      title: p.title,
      colour: p.colour,
      department_id: p.department_id,
      manager_id: p.manager_id,
    }));

  const departments = viewer.org.departments
    .filter((d) => viewer.departmentIds.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, colour: d.colour, enabled: d.enabled }));

  const pipelineOptions = items.map((i) => ({ id: i.id, name: i.activity }));
  const holidays = holidayMap();

  const statusMix = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.current_status] = (acc[item.current_status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="page">
      <PageHeader
        id="tab.pipeline" path="/pipeline" canEdit={canEdit(viewer)}
        title="Recording pipeline"
        description="Combined QA and pipeline view. QA and pipeline labels stay separate; Active QA overlaps suppress eligibility, while inactive QA never blocks recording work."
        meta={
          <>
            {stats.total} operational recordings · {stats.test} TEST records excluded · {stats.eligible} eligible days
            this month
          </>
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
          <div className="kpi-label">Operational recordings</div>
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-foot">{stats.complete} complete · {stats.test} test rows withheld</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--good)" }}>
          <div className="kpi-label">Eligible recording days</div>
          <div className="kpi-value">{stats.eligible}<small>days</small></div>
          <div className="kpi-foot">weekdays − holidays − exclusions − QA overlaps</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--bad)" }}>
          <div className="kpi-label">Blocked days</div>
          <div className="kpi-value">{stats.blocked}</div>
          <div className="kpi-foot">{statusMix["Blocked"] ?? 0} items marked Blocked</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--warn)" }}>
          <div className="kpi-label">Average automation</div>
          <div className="kpi-value">{stats.avgAutomation}<small>%</small></div>
          <div className="kpi-foot">{stats.warnings} warnings surfaced</div>
        </div>
      </div>

      <PageGuidance id="tab.pipeline" path="/pipeline" canEdit={canEdit(viewer)} />

      <Section
        id="sec.pipeline.availability"
        tabId="tab.pipeline"
        title="Availability"
        description="Green = eligible weekday, amber = NSW public holiday, grey = weekend. Manual exclusions and QA overlaps are visible per recording below."
        path="/pipeline"
        canEdit={canEdit(viewer)}
      >
        <div className="card-body">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {availability.map((day) => (
              <div
                key={day.date}
                title={`${day.date}${day.holidayName ? ` · ${day.holidayName}` : ""}`}
                style={{
                  width: 36,
                  height: 44,
                  borderRadius: 7,
                  border: day.isToday ? "1.5px solid var(--brand)" : "1px solid var(--border)",
                  background: day.isHoliday
                    ? "rgba(251,191,36,0.16)"
                    : day.isWeekend
                      ? "var(--surface-3)"
                      : "rgba(52,211,153,0.12)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: day.isHoliday ? "var(--warn)" : day.isWeekend ? "var(--muted)" : "var(--good)",
                }}
              >
                {day.day}
              </div>
            ))}
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>
            {monthLabel(monthStart(monthKey))} · {Object.keys(holidays).length} holidays loaded · exclusions apply per
            recording unless global.
          </div>
        </div>
      </Section>

      <Section
        id="sec.pipeline.board"
        tabId="tab.pipeline"
        title="Recording pipeline"
        description="Planned vs actual windows, automation %, blockers and warnings. TEST rows stay explicitly marked."
        path="/pipeline"
        canEdit={canEdit(viewer)}
        bare
      >
        <PipelineBoard
          items={items.map(toClientPipeline)}
          people={people}
          departments={departments}
          canEdit={canEdit(viewer)}
          path="/pipeline"
          availability={availability}
          canConfirm={canAdmin(viewer)}
        />
      </Section>

      <Section
        id="sec.pipeline.exclusions"
        tabId="tab.pipeline"
        title="Manual exclusions"
        description="Date-specific exclusions with an audited reason. A recording-scoped exclusion only affects that item; leave blank to exclude the date globally."
        path="/pipeline"
        canEdit={canEdit(viewer)}
      >
        <div className="card-pad stack">
          {canEdit(viewer) ? (
            <form action={addExclusionAction} className="inline-form">
              <div className="field">
                <label htmlFor="exc-date">Date</label>
                <input id="exc-date" className="input input-sm" type="date" name="date" defaultValue={today} required />
              </div>
              <div className="field grow" style={{ minWidth: 220 }}>
                <label htmlFor="exc-reason">Reason *</label>
                <input id="exc-reason" className="input input-sm" name="reason" placeholder="e.g. environment unavailable" required />
              </div>
              <div className="field">
                <label htmlFor="exc-item">Applies to</label>
                <select id="exc-item" className="select select-sm" name="pipeline_id" defaultValue="" style={{ maxWidth: 220 }}>
                  <option value="">All recordings (global)</option>
                  {pipelineOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary btn-sm" type="submit">
                <Icon name="plus" size={13} /> Add exclusion
              </button>
            </form>
          ) : null}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Scope</th>
                  <th>Reason</th>
                  <th>Created by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {exclusions.map((exclusion: any) => (
                  <tr key={exclusion.id}>
                    <td className="mono">{exclusion.date}</td>
                    <td>
                      {exclusion.pipeline_id ? (
                        <span className="badge badge-purple">
                          {pipelineOptions.find((o) => o.id === exclusion.pipeline_id)?.name ?? "Recording"}
                        </span>
                      ) : (
                        <span className="badge badge-slate">Global</span>
                      )}
                    </td>
                    <td>{exclusion.reason}</td>
                    <td className="muted">{exclusion.created_by_name ?? "—"}</td>
                    <td className="right">
                      {canEdit(viewer) ? (
                        <form action={removeExclusionAction}>
                          <input type="hidden" name="id" value={exclusion.id} />
                          <button className="btn btn-sm btn-ghost" type="submit">
                            <Icon name="trash" size={12} /> Remove
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!exclusions.length ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty">No exclusions recorded.</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </main>
  );
}
