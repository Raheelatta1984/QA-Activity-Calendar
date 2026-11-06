import Link from "next/link";
import { getViewer, canEdit } from "@/lib/access";
import { capacityMonth, demandByDay } from "@/lib/capacity";
import { addMonths, isoToday, monthLabel, monthStart, weekdayShort } from "@/lib/dates";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { CapacityBoard } from "@/components/CapacityBoard";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function CapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const viewer = await getViewer();
  const settings = appSettings();
  const params = await searchParams;
  const today = isoToday();
  const monthKey = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : today.slice(0, 7);
  const month = capacityMonth(viewer, monthKey);
  const demand = demandByDay(viewer, month.start, month.end);

  const monthOptions = Array.from({ length: 13 }, (_, i) => {
    const key = addMonths(`${today.slice(0, 7)}-01`, i - 4).slice(0, 7);
    return { key, label: monthLabel(monthStart(key)) };
  });

  const holidayRecord: Record<string, string> = {};
  for (const [date, name] of month.holidays.entries()) holidayRecord[date] = name;

  const workingDemand = demand.filter((d) => d.working);
  const peak = Math.max(1, ...workingDemand.map((d) => d.fte), month.people.length || 1);
  const overAllocated = month.people.filter((p) => p.over_allocated_days.length > 0);
  const peopleWithoutEntries = month.people.filter((p) => p.days_without_entry.length > 0);

  return (
    <main className="page">
      <PageHeader
        id="tab.capacity" path="/capacity" canEdit={canEdit(viewer)}
        title="Capacity planner"
        description="Resource × day capacity with explicit hour categories. Occupied capacity (including leave and DevOps) is kept separate from productive QA utilisation and from FTE demand."
        meta={
          <>
            {month.people.length} people · {month.totals.working_days} working days · {month.totals.total_hours}h total ·{" "}
            default {settings.hoursPerDay}h/day
          </>
        }
        action={
          <Link className="btn btn-sm" href={`/fte?month=${monthKey}`}>
            <Icon name="target" size={13} /> FTE calendar by activity
          </Link>
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--accent)" }}>
          <div className="kpi-label">Total hours</div>
          <div className="kpi-value">{month.totals.total_hours}<small>h</small></div>
          <div className="kpi-foot">per-person defaults preserved (7.6 or 4)</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--brand)" }}>
          <div className="kpi-label">Occupied capacity</div>
          <div className="kpi-value">{month.totals.utilisation}<small>%</small></div>
          <div className="kpi-foot">{month.totals.occupied}h including unavailable time</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: "var(--purple)" }}>
          <div className="kpi-label">Average daily FTE demand</div>
          <div className="kpi-value">{month.totals.fte_demand}<small>FTE</small></div>
          <div className="kpi-foot">active FTE summed per working day ÷ {month.totals.working_days} days</div>
        </div>
        <div className="kpi" style={{ ["--kpi-accent" as string]: overAllocated.length ? "var(--bad)" : "var(--good)" }}>
          <div className="kpi-label">Over-allocated people</div>
          <div className="kpi-value">{overAllocated.length}</div>
          <div className="kpi-foot">{peopleWithoutEntries.length} with missing daily entries</div>
        </div>
      </div>

      <PageGuidance id="tab.capacity" path="/capacity" canEdit={canEdit(viewer)} />

      <Section
        id="sec.capacity.grid"
        tabId="tab.capacity"
        title="Resource × day grid"
        description="Click any cell to edit hours. Values show total hours; NA means fully unavailable, H means NSW public holiday."
        path="/capacity"
        canEdit={canEdit(viewer)}
        bare
      >
        {overAllocated.length ? (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            <Icon name="alert" size={15} />
            <span>
              {overAllocated.map((p) => p.name.split(" ")[0]).join(", ")} carry more than 1.0 FTE of active work on at
              least one day this month. Rebalance assignments or record an effort override.
            </span>
            <Link className="btn btn-sm" href="/calendar">
              Review activities
            </Link>
          </div>
        ) : null}
        <CapacityBoard
          people={month.people.map((p) => ({
            person_id: p.person_id,
            name: p.name,
            colour: p.colour,
            department_name: p.department_name,
            working_days: p.working_days,
            total_hours: p.total_hours,
            not_available: p.not_available,
            devops: p.devops,
            recording: p.recording,
            qa_testing: p.qa_testing,
            occupied: p.occupied,
            utilisation: p.utilisation,
            fte_demand: p.fte_demand,
            days_without_entry: p.days_without_entry,
            cells: p.cells.map((c) => ({
              date: c.date,
              not_available_hours: c.not_available_hours,
              devops_hours: c.devops_hours,
              recording_hours: c.recording_hours,
              qa_testing_hours: c.qa_testing_hours,
              total_hours: c.total_hours,
              note: c.note,
            })),
          }))}
          days={month.days}
          holidays={holidayRecord}
          monthKey={monthKey}
          monthOptions={monthOptions}
          canEdit={canEdit(viewer)}
        />
      </Section>

      <Section
        id="sec.capacity.pivot"
        tabId="tab.capacity"
        title="Monthly pivot"
        description="Rebuilt from resource-day entries — no precomputed spreadsheet cells. Utilisation includes absence; productive utilisation is QA testing only."
        path="/capacity"
        canEdit={canEdit(viewer)}
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Person</th>
                <th>Department</th>
                <th className="num">Days</th>
                <th className="num">Total h</th>
                <th className="num">Unavailable</th>
                <th className="num">DevOps</th>
                <th className="num">Recording</th>
                <th className="num">QA testing</th>
                <th className="num">Occupied</th>
                <th className="num">Utilisation</th>
                <th className="num">FTE demand</th>
              </tr>
            </thead>
            <tbody>
              {month.people.map((person) => (
                <tr key={person.person_id}>
                  <td>
                    <span className="row" style={{ gap: 7 }}>
                      <span className="avatar" style={{ width: 22, height: 22, flex: "0 0 22px", background: person.colour, fontSize: "0.6rem" }}>
                        {person.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                      </span>
                      {person.name}
                    </span>
                  </td>
                  <td className="muted">{person.department_name}</td>
                  <td className="num">{person.working_days}</td>
                  <td className="num">{person.total_hours}</td>
                  <td className="num">{person.not_available}</td>
                  <td className="num">{person.devops}</td>
                  <td className="num">{person.recording}</td>
                  <td className="num">{person.qa_testing}</td>
                  <td className="num">{person.occupied}</td>
                  <td className="num">
                    <span className={`badge ${person.utilisation > 100 ? "badge-red" : person.utilisation > 90 ? "badge-amber" : "badge-green"}`}>
                      {person.utilisation}%
                    </span>
                  </td>
                  <td className="num">{person.fte_demand}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid var(--border-strong)" }}>
                <td colSpan={3}><strong>Total</strong></td>
                <td className="num"><strong>{month.totals.total_hours}</strong></td>
                <td className="num" colSpan={3} />
                <td className="num" colSpan={2}><strong>{month.totals.occupied}h</strong></td>
                <td className="num"><strong>{month.totals.utilisation}%</strong></td>
                <td className="num"><strong>{month.totals.fte_demand}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>

      <Section
        id="sec.capacity.demand"
        tabId="tab.capacity"
        title="FTE demand over working days"
        description="Sums active FTE across inclusive dates. Weekends and NSW holidays are non-working — distinguished from zero demand."
        path="/capacity"
        canEdit={canEdit(viewer)}
      >
        <div className="card-body">
          <div className="bar-chart" style={{ height: 150 }}>
            {workingDemand.map((day) => (
              <div className="bar-col" key={day.date} title={`${day.date}: ${day.fte} FTE across ${day.count} activities`}>
                <div className="bar-label">{day.fte}</div>
                <div
                  className="bar"
                  style={{
                    height: `${Math.max(3, (day.fte / peak) * 100)}%`,
                    background:
                      day.fte > month.people.length
                        ? "linear-gradient(180deg, var(--bad), #b91c1c)"
                        : undefined,
                  }}
                />
                <div className="bar-label">{weekdayShort(day.date).slice(0, 2)} {Number(day.date.slice(8))}</div>
              </div>
            ))}
          </div>
          <div className="row-between" style={{ marginTop: 10 }}>
            <span className="card-sub">
              Peak demand {Math.max(...workingDemand.map((d) => d.fte), 0)} FTE vs {month.people.length} available people.
              Bars above capacity are red.
            </span>
            <span className="badge badge-slate">
              {demand.filter((d) => !d.working).length} non-working days excluded
            </span>
          </div>
        </div>
      </Section>
    </main>
  );
}
