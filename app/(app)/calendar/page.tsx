import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { listActivities } from "@/lib/activities";
import { holidayMap, listPipeline } from "@/lib/pipeline";
import {
  addMonths,
  buildMonthGrid,
  fiscalMonths,
  fiscalQuarters,
  fiscalYearLabel,
  fiscalYearOf,
  fiscalYearStartYearFromLabel,
  isIsoDate,
  isoToday,
  monthLabel,
  monthStart,
} from "@/lib/dates";
import { appSettings } from "@/lib/settings";
import { Section } from "@/components/Section";
import { CalendarBoard } from "@/components/CalendarBoard";
import { toClientActivity, toClientPipeline } from "@/lib/serialize";
import { PageHeader, PageGuidance } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; q?: string; month?: string }>;
}) {
  const viewer = await getViewer();
  const settings = appSettings();
  const params = await searchParams;
  const today = isoToday();
  const currentFiscal = fiscalYearOf(today, settings.fiscalStartMonth);

  const years = new Set<string>();
  for (let i = -1; i <= 2; i += 1) years.add(fiscalYearLabel(currentFiscal.startYear + i));
  for (const row of all<{ start_date: string | null }>(
    `SELECT start_date FROM activities WHERE start_date IS NOT NULL`
  )) {
    if (isIsoDate(row.start_date)) years.add(fiscalYearOf(row.start_date, settings.fiscalStartMonth).label);
  }
  const yearOptions = [...years].sort().map((label) => ({
    label,
    startYear: fiscalYearStartYearFromLabel(label),
  }));

  const selectedYear = params.fy && years.has(params.fy) ? params.fy : currentFiscal.label;
  const startYear = fiscalYearStartYearFromLabel(selectedYear);
  const quarters = fiscalQuarters(startYear, settings.fiscalStartMonth);
  const months = fiscalMonths(startYear, settings.fiscalStartMonth);

  const validMonth = params.month && months.some((m) => m.key === params.month) ? params.month : null;
  const selectedQuarterRaw = Number(params.q);
  const selectedQuarter = selectedQuarterRaw >= 1 && selectedQuarterRaw <= 4 ? selectedQuarterRaw : null;

  const fallbackMonth =
    today.slice(0, 7) >= months[0].key && today.slice(0, 7) <= months[months.length - 1].key
      ? today.slice(0, 7)
      : months[0].key;
  const monthKey = validMonth ?? fallbackMonth;
  const monthOption = quarters.flatMap((q) => q.months).find((m) => m.key === monthKey);
  const quarterForMonth = selectedQuarter ?? monthOption?.quarter ?? 1;

  const monthStartIso = monthStart(monthKey);
  const monthEndIso = addMonths(monthStartIso, 1);
  const holidays = holidayMap();
  const grid = buildMonthGrid(monthKey, { holidays, today });

  const activities = listActivities(viewer, {
    from: grid.weeks[0][0].date,
    to: grid.weeks[5][6].date,
  }).filter((a) => a.active === 1);

  const pipeline = listPipeline(viewer).filter(
    (p) => p.effective_start && p.effective_end && p.effective_start < monthEndIso && p.effective_end >= monthStartIso
  );

  const legend = all<{ name: string; hex: string }>(
    `SELECT name, hex FROM colour_rules WHERE enabled = 1 AND applies_to IN ('activity','pipeline') ORDER BY name LIMIT 6`
  );

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
      department_name: viewer.org.deptById.get(p.department_id ?? "")?.name,
    }));

  const departments = viewer.org.departments
    .filter((d) => viewer.departmentIds.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, colour: d.colour, enabled: d.enabled }));

  const monthHolidays = [...holidays.entries()]
    .filter(([date]) => date.slice(0, 7) === monthKey)
    .map(([date, name]) => ({ date, name }));

  const activeInMonth = activities.filter(
    (a) => a.start_date && a.end_date && a.start_date <= grid.end && a.end_date >= grid.start
  );

  return (
    <main className="page">
      <PageHeader
        id="tab.calendar" path="/calendar" canEdit={canEdit(viewer)}
        title="QA Calendar"
        description="Fiscal-year month grid built from the activity ledger. Only Active activities render — weekends, NSW public holidays, today and the current week are highlighted."
        meta={
          <>
            {activeInMonth.length} activities · {grid.workingDays} working days · Q{quarterForMonth} {selectedYear}
          </>
        }
      />

      <PageGuidance id="tab.calendar" path="/calendar" canEdit={canEdit(viewer)} />

      <Section
        id="sec.calendar.filters"
        tabId="tab.calendar"
        title="Fiscal selectors"
        description="Year → quarter → month. A month selection overrides the quarter; the URL keeps the view shareable."
        path="/calendar"
        canEdit={canEdit(viewer)}
        bare
      >
        <div className="card card-pad" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {yearOptions.map((y) => (
            <a
              key={y.label}
              href={`/calendar?fy=${y.label}`}
              className={`btn btn-sm ${y.label === selectedYear ? "btn-primary" : ""}`}
            >
              {y.label}
              <span className="mono" style={{ opacity: 0.7 }}>
                Jul {String(y.startYear).slice(2)}–Jun {String(y.startYear + 1).slice(2)}
              </span>
            </a>
          ))}
          <div style={{ width: 1, background: "var(--border)", margin: "0 4px" }} />
          {quarters.map((q) => (
            <a
              key={q.quarter}
              href={`/calendar?fy=${selectedYear}&q=${q.quarter}&month=${q.months[0].key}`}
              className={`btn btn-sm ${q.quarter === quarterForMonth ? "" : "btn-ghost"}`}
            >
              Q{q.quarter} · {monthLabel(q.start).split(" ")[0]}–{monthLabel(q.end).split(" ")[0]}
            </a>
          ))}
          <span className="card-sub" style={{ marginLeft: "auto", alignSelf: "center" }}>
            {selectedYear} = July {startYear} – June {startYear + 1}
          </span>
        </div>
      </Section>

      <Section
        id="sec.calendar.grid"
        tabId="tab.calendar"
        title="Month grid"
        description="Dates are inclusive. Click a block to open the activity and record the actual start; double-click a day to create one."
        path="/calendar"
        canEdit={canEdit(viewer)}
        bare
      >
        <CalendarBoard
          monthKey={monthKey}
          monthLabel={monthLabel(monthStartIso)}
          selectedYear={selectedYear}
          selectedQuarter={quarterForMonth}
          years={yearOptions}
          quarters={quarters}
          days={grid.weeks}
          todayIso={today}
          activities={activeInMonth.map(toClientActivity)}
          pipeline={pipeline.map(toClientPipeline)}
          people={people}
          departments={departments}
          legend={legend}
          holidays={monthHolidays}
          canEdit={canEdit(viewer)}
          path="/calendar"
        />
      </Section>

      <Section
        id="sec.calendar.legend"
        tabId="tab.calendar"
        title="Colour dictionary & holiday configuration"
        description="Colours and holidays are configuration, not free text. Holidays feed the FTE projection and pipeline eligibility."
        path="/calendar"
        canEdit={canEdit(viewer)}
      >
        <div className="card-pad grid-2">
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Activity colours</div>
            <div className="row">
              {all<{ name: string; hex: string; meaning: string | null }>(
                `SELECT name, hex, meaning FROM colour_rules WHERE enabled = 1 ORDER BY name`
              ).map((rule) => (
                <span className="badge badge-slate" key={rule.name} title={rule.meaning ?? ""}>
                  <span className="legend-swatch" style={{ background: rule.hex }} /> {rule.name}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>NSW holidays in this fiscal year</div>
            <div className="row" style={{ gap: 6 }}>
              {all<{ date: string; name: string }>(
                `SELECT date, name FROM holidays WHERE date >= ? AND date <= ? ORDER BY date`,
                `${startYear}-07-01`,
                `${startYear + 1}-06-30`
              ).map((h) => (
                <span className="badge badge-amber" key={h.date} title={h.name}>
                  {h.date.slice(5)} · {h.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
