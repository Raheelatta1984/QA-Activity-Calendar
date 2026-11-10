import { all } from "./db";
import { departmentScope, matchesDepartment, type Viewer } from "./access";
import { listActivities, type ActivityView } from "./activities";
import {
  addDays,
  addMonths,
  eachDay,
  isoToday,
  isWorkingDay,
  monthLabel,
  monthStart,
  weekdayShort,
} from "./dates";
import { holidayMap } from "./pipeline";
import { appSettings } from "./settings";
import { RELEASE_GROUP, releaseDemandRows } from "./releases";

/**
 * FTE calendar — planned activity × day demand with totals.
 *
 * Purpose: let a QA manager look at one month (or quarter), see which testing
 * activity needs how much FTE on which day, and compare the daily total against
 * the people actually available so resources can be arranged.
 *
 * Rules kept consistent with the rest of the app:
 *  - Only **Active** activities with a valid inclusive date range contribute.
 *  - FTE uses the documented precedence (override → Regression default →
 *    stored FTE → configured default) via `effective_fte`.
 *  - Every day inside [start_date, end_date] carries the full FTE value. This
 *    is FTE *demand per day*, not FTE-days spread across the window.
 *  - Weekends and NSW holidays are non-working; they are shown but excluded from
 *    the working-day totals so a blank month is not mistaken for zero work.
 */

/**
 * Activity groups that represent testing work (documentation of intent).
 *
 * The runtime "testing activity only" filter is deliberately a **denylist**
 * (`NON_TESTING_GROUPS`): a group the app has never seen must still appear in
 * the calendar, because silently dropping unknown work is worse than showing it.
 */
export const TESTING_GROUPS = ["Regression", "Automation", "Performance", "Security", "Integration", "UAT"] as const;
/** Groups excluded when the "testing activity only" filter is on. */
export const NON_TESTING_GROUPS = ["Recording"] as const;

export type FteRange = "month" | "quarter";

export type FteDay = {
  date: string;
  day: number;
  weekday: string;
  weekdayShort: string;
  monthKey: string;
  working: boolean;
  holiday: string | null;
  isToday: boolean;
  isWeekend: boolean;
};

export type FteCell = {
  /** FTE demanded on this day (0 when the activity does not span the day). */
  fte: number;
  /** True when the activity's inclusive window covers this day. */
  active: boolean;
};

/** Where a demand row came from: an activity record or a release QA window. */
export type FteRowKind = "activity" | "release";

export type FteActivityRow = {
  id: string;
  /** `release` rows are merged from `release_feed` + `release_assignees`. */
  kind: FteRowKind;
  /** Where a click on the row should go (release rows are not activities). */
  href: string;
  code: string | null;
  activity: string;
  project_name?: string | null;
  detail: string | null;
  group: string;
  colour: string;
  status: string;
  priority: string;
  department_id: string | null;
  department_name: string;
  department_colour: string;
  assignee_id: string | null;
  assignee_name: string;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  effective_fte: number;
  derived_progress: number;
  cells: FteCell[];
  /** Σ FTE across the visible days (calendar days). */
  total_fte_days: number;
  /** Σ FTE across working days only. */
  total_fte_working: number;
  /** Days the activity spans inside the visible range. */
  covered_days: number;
  hours_total: number;
};

export type FteAssigneeRollup = {
  person_id: string | null;
  name: string;
  colour: string;
  title: string | null;
  department_name: string;
  activities: number;
  fte_days: number;
  avg_fte: number;
  peak_fte: number;
  peak_date: string | null;
  available_fte: number;
  variance_fte: number;
  over_days: number;
};

export type FteGroupRollup = {
  group: string;
  colour: string;
  activities: number;
  fte_days: number;
  share: number;
};

export type FteTotals = {
  /** Activity rows in the matrix (release rows are counted separately). */
  activities: number;
  /** Release QA-window rows in the matrix. */
  releases: number;
  /** Demand contributed by release QA windows, in FTE-days. */
  release_fte_days: number;
  people: number;
  /** Σ FTE over every calendar day in range. */
  fte_days: number;
  /** Σ FTE over working days only — the number used for resourcing. */
  fte_days_working: number;
  hours: number;
  avg_daily_fte: number;
  peak_fte: number;
  peak_dates: string[];
  /** Nominal supply: headcount × working days. */
  supply_fte_days: number;
  /** Recorded unavailability (leave + DevOps) removed from nominal supply. */
  unavailable_fte_days: number;
  /** supply − demand in FTE-days (negative = short of people). */
  variance_fte_days: number;
  /** People needed to cover an average working day. */
  required_headcount_avg: number;
  /** People needed to cover the peak day. */
  required_headcount_peak: number;
  headcount: number;
  working_days: number;
  calendar_days: number;
  over_days: { date: string; fte: number }[];
  idle_days: { date: string; fte: number }[];
  unscheduled: number;
};

export type FteCalendarResult = {
  range: FteRange;
  monthKey: string;
  quarter: number | null;
  label: string;
  start: string;
  end: string;
  days: FteDay[];
  rows: FteActivityRow[];
  /** One entry per day, aligned with `days`. */
  daily_totals: number[];
  daily_activity_counts: number[];
  totals: FteTotals;
  by_assignee: FteAssigneeRollup[];
  by_group: FteGroupRollup[];
  scope: {
    department_id: string | null;
    department_name: string;
    group: string | null;
    assignee_id: string | null;
    testing_only: boolean;
    search: string;
  };
  hoursPerDay: number;
};

export type FteFilters = {
  /** Merge release QA-window demand into the matrix (default true). */
  includeReleases?: boolean;
  range?: FteRange;
  monthKey?: string;
  quarter?: number | null;
  departmentId?: string | null;
  group?: string | null;
  assigneeId?: string | null;
  testingOnly?: boolean;
  search?: string;
};

/** Fiscal quarter bounds for the fiscal year that contains `monthKey`. */
export function quarterBounds(monthKey: string, quarter: number, fiscalStartMonth = 7) {
  const safeQuarter = Math.min(4, Math.max(1, quarter));
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = ((fiscalStartMonth - 1 + i) % 12) + 1;
    const year = Number(monthKey.slice(0, 4)) + (month < fiscalStartMonth ? 1 : 0);
    return `${year}-${String(month).padStart(2, "0")}`;
  });
  const slice = months.slice((safeQuarter - 1) * 3, (safeQuarter - 1) * 3 + 3);
  return {
    start: `${slice[0]}-01`,
    end: addDays(addMonths(`${slice[2]}-01`, 1), -1),
    months: slice,
  };
}

/** Fiscal quarter (1–4) that contains a month, given the fiscal start month. */
export function quarterOfMonth(monthKey: string, fiscalStartMonth = 7): number {
  const index = (Number(monthKey.slice(5, 7)) - fiscalStartMonth + 12) % 12;
  return Math.floor(index / 3) + 1;
}

export function buildDays(start: string, end: string, holidays: Map<string, string>, today: string): FteDay[] {
  return eachDay(start, end).map((date) => {
    const holiday = holidays.get(date) ?? null;
    const weekend = !isWorkingDay(date, new Set());
    return {
      date,
      day: Number(date.slice(8, 10)),
      weekday: weekdayShort(date),
      weekdayShort: weekdayShort(date).slice(0, 2),
      monthKey: date.slice(0, 7),
      working: !weekend && !holiday,
      holiday,
      isToday: date === today,
      isWeekend: weekend,
    };
  });
}

/** People in scope for the selected department, honouring viewer visibility. */
export function peopleInScope(viewer: Viewer, departmentId: string | null) {
  return viewer.org.people
    .filter((p) => !!p.active)
    .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
    .filter((p) => !p.department_id || viewer.departmentIds.has(p.department_id))
    .filter((p) => matchesDepartment(viewer, p.department_id))
    .filter((p) => !departmentId || p.department_id === departmentId);
}

/** Default department: the viewer's active scope, else a QA-like department. */
export function defaultDepartmentId(viewer: Viewer): string | null {
  const selected = departmentScope(viewer);
  if (selected.length === 1 && viewer.departmentIds.has(selected[0])) {
    return selected[0];
  }
  const qa = viewer.org.departments.find(
    (d) => !!d.enabled && viewer.departmentIds.has(d.id) && /^qa$|quality/i.test(`${d.code} ${d.name}`)
  );
  return qa?.id ?? null;
}

export function fteCalendar(viewer: Viewer, filters: FteFilters = {}): FteCalendarResult {
  const settings = appSettings();
  const today = isoToday();
  const range: FteRange = filters.range === "quarter" ? "quarter" : "month";
  const monthKey = /^\d{4}-\d{2}$/.test(filters.monthKey ?? "") ? filters.monthKey! : today.slice(0, 7);

  let start: string;
  let end: string;
  let quarter: number | null = null;
  if (range === "quarter") {
    quarter = filters.quarter && filters.quarter >= 1 && filters.quarter <= 4 ? filters.quarter : quarterOfMonth(monthKey, settings.fiscalStartMonth);
    const bounds = quarterBounds(monthKey, quarter, settings.fiscalStartMonth);
    start = bounds.start;
    end = bounds.end;
  } else {
    start = monthStart(monthKey);
    end = addDays(addMonths(start, 1), -1); // inclusive last day of the month
  }

  const holidays = holidayMap();
  const days = buildDays(start, end, holidays, today);
  const workingDays = days.filter((d) => d.working);

  const departmentId = filters.departmentId ?? defaultDepartmentId(viewer);
  const testingOnly = filters.testingOnly !== false;

  const activities = listActivities(viewer, {
    from: start,
    to: end,
    departmentId: departmentId ?? undefined,
    group: filters.group ?? undefined,
    assigneeId: filters.assigneeId ?? undefined,
    search: filters.search?.trim() || undefined,
  }).filter((a) => a.active === 1 && a.scheduled);

  const visible = testingOnly
    ? activities.filter((a) => !NON_TESTING_GROUPS.includes(a.activity_group as (typeof NON_TESTING_GROUPS)[number]))
    : activities;

  /**
   * A demand row is anything that consumes FTE on a day: an activity record or
   * a release QA window (one row per assignee). Both are normalised here so the
   * matrix, the daily totals and the per-person roll-ups treat them alike — a
   * release can no longer sit outside the capacity picture.
   */
  type DemandInput = {
    id: string;
    kind: FteRowKind;
    href: string;
    code: string | null;
    activity: string;
    project_name?: string | null;
    detail: string | null;
    group: string;
    colour: string;
    status: string;
    priority: string;
    department_id: string | null;
    department_name: string;
    department_colour: string;
    assignee_id: string | null;
    assignee_name: string;
    start_date: string | null;
    end_date: string | null;
    duration_days: number | null;
    effective_fte: number;
    derived_progress: number;
  };

  const activityInputs: DemandInput[] = visible.map((activity) => ({
    id: activity.id,
    kind: "activity",
    href: `/calendar?month=${(activity.start_date ?? start).slice(0, 7)}&activity=${activity.id}`,
    code: activity.code,
    activity: activity.activity,
    project_name: activity.project_name,
    detail: activity.detail,
    group: activity.activity_group,
    colour: activity.colour,
    status: activity.status,
    priority: activity.priority,
    department_id: activity.department_id,
    department_name: activity.department_name,
    department_colour: activity.department_colour,
    assignee_id: activity.assignee_id,
    assignee_name: activity.assignee_name,
    start_date: activity.start_date,
    end_date: activity.end_date,
    duration_days: activity.duration_days,
    effective_fte: activity.effective_fte,
    derived_progress: activity.derived_progress,
  }));

  const searchTerm = (filters.search ?? "").trim().toLowerCase();
  const personDepartment = new Map(viewer.org.people.map((person) => [person.id, person.department_id]));
  const releaseInputs: DemandInput[] =
    filters.includeReleases === false
      ? []
      : releaseDemandRows(viewer, start, end)
          .filter(
            (row) =>
              !departmentId ||
              row.department_id === departmentId ||
              (!!row.assignee_id && personDepartment.get(row.assignee_id) === departmentId)
          )
          .filter((row) => !filters.group || row.group === filters.group)
          .filter((row) => !filters.assigneeId || row.assignee_id === filters.assigneeId)
          .filter(
            (row) =>
              !searchTerm ||
              `${row.activity} ${(row as { project_name?: string | null }).project_name ?? ""} ${row.detail ?? ""} ${row.assignee_name}`
                .toLowerCase()
                .includes(searchTerm)
          )
          .map((row) => ({
            id: row.id,
            kind: "release" as const,
            href: "/releases",
            code: null,
            activity: row.activity,
            detail: row.detail,
            group: row.group,
            colour: row.colour,
            status: row.status,
            priority: row.priority,
            department_id: row.department_id,
            department_name: row.department_name,
            department_colour: row.department_colour,
            assignee_id: row.assignee_id,
            assignee_name: row.assignee_name,
            start_date: row.start_date,
            end_date: row.end_date,
            duration_days: row.duration_days,
            effective_fte: row.fte,
            derived_progress: row.progress,
          }));

  const inputs: DemandInput[] = [...activityInputs, ...releaseInputs];

  const rows: FteActivityRow[] = inputs.map((activity) => {
    const cells: FteCell[] = days.map((day) => {
      const active =
        !!activity.start_date && !!activity.end_date && activity.start_date <= day.date && activity.end_date >= day.date;
      return { fte: active ? activity.effective_fte : 0, active };
    });
    const totalFteDays = round(cells.reduce((sum, c) => sum + c.fte, 0));
    const totalWorking = round(cells.reduce((sum, c, index) => (days[index].working ? sum + c.fte : sum), 0));
    return {
      id: activity.id,
      kind: activity.kind,
      href: activity.href,
      code: activity.code,
      activity: activity.activity,
      detail: activity.detail,
      group: activity.group,
      colour: activity.colour,
      status: activity.status,
      priority: activity.priority,
      department_id: activity.department_id,
      department_name: activity.department_name,
      department_colour: activity.department_colour,
      assignee_id: activity.assignee_id,
      assignee_name: activity.assignee_name,
      start_date: activity.start_date,
      end_date: activity.end_date,
      duration_days: activity.duration_days,
      effective_fte: activity.effective_fte,
      derived_progress: activity.derived_progress,
      cells,
      total_fte_days: totalFteDays,
      total_fte_working: totalWorking,
      covered_days: cells.filter((c) => c.active).length,
      hours_total: round(totalFteDays * settings.hoursPerDay),
    };
  });

  rows.sort((a, b) => {
    if (a.start_date !== b.start_date) return (a.start_date ?? "9999-12-31") < (b.start_date ?? "9999-12-31") ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "activity" ? -1 : 1;
    return a.activity.localeCompare(b.activity);
  });

  const daily_totals = days.map((_, index) => round(rows.reduce((sum, row) => sum + row.cells[index].fte, 0)));
  const daily_activity_counts = days.map((_, index) => rows.filter((row) => row.cells[index].active).length);

  const peakFte = daily_totals.length ? Math.max(...daily_totals) : 0;
  const peakDates = days.filter((_, index) => peakFte > 0 && daily_totals[index] === peakFte).map((d) => d.date);
  const fteDays = round(daily_totals.reduce((sum, v) => sum + v, 0));
  const fteDaysWorking = round(days.reduce((sum, day, index) => (day.working ? sum + daily_totals[index] : sum), 0));

  // ---- supply: headcount × working days, less recorded unavailability ------
  const people = peopleInScope(viewer, departmentId);
  const headcount = people.length;
  const capacityRows = all<{ person_id: string; date: string; not_available_hours: number; devops_hours: number }>(
    `SELECT person_id, date, not_available_hours, devops_hours FROM resource_day_capacity WHERE date >= ? AND date <= ?`,
    start,
    end
  );
  const byPersonDay = new Map(capacityRows.map((r) => [`${r.person_id}|${r.date}`, r]));
  let unavailableHours = 0;
  for (const person of people) {
    for (const day of workingDays) {
      const entry = byPersonDay.get(`${person.id}|${day.date}`);
      if (entry) unavailableHours += entry.not_available_hours + entry.devops_hours;
    }
  }
  const unavailableFteDays = round(unavailableHours / (settings.hoursPerDay || 7.6));
  const supplyFteDays = round(headcount * workingDays.length - unavailableFteDays);
  const varianceFteDays = round(supplyFteDays - fteDaysWorking);

  const overDays: { date: string; fte: number }[] = [];
  const idleDays: { date: string; fte: number }[] = [];
  days.forEach((day, index) => {
    if (!day.working) return;
    if (headcount > 0 && daily_totals[index] > headcount) overDays.push({ date: day.date, fte: daily_totals[index] });
    if (daily_totals[index] === 0) idleDays.push({ date: day.date, fte: 0 });
  });

  // ---- rollups ------------------------------------------------------------
  const perPersonDaily = new Map<string, number[]>();
  days.forEach((day, index) => {
    const sums = new Map<string, number>();
    for (const row of rows) {
      if (!row.cells[index].active) continue;
      const key = row.assignee_id ?? "__unassigned__";
      sums.set(key, (sums.get(key) ?? 0) + row.cells[index].fte);
    }
    for (const [key, value] of sums.entries()) {
      const list = perPersonDaily.get(key) ?? [];
      list[index] = value;
      perPersonDaily.set(key, list);
    }
  });

  const personById = new Map(viewer.org.people.map((p) => [p.id, p]));
  const assigneeMap = new Map<string, FteAssigneeRollup>();
  for (const row of rows) {
    const key = row.assignee_id ?? "__unassigned__";
    const person = row.assignee_id ? personById.get(row.assignee_id) : undefined;
    const rollup: FteAssigneeRollup =
      assigneeMap.get(key) ??
      {
        person_id: row.assignee_id,
        name: row.assignee_id ? row.assignee_name : "Unassigned",
        colour: person?.colour ?? "#64748b",
        title: person?.title ?? null,
        department_name: row.department_name,
        activities: 0,
        fte_days: 0,
        avg_fte: 0,
        peak_fte: 0,
        peak_date: null,
        available_fte: 1,
        variance_fte: 0,
        over_days: 0,
      };
    rollup.activities += 1;
    rollup.fte_days = round(rollup.fte_days + row.total_fte_days);
    assigneeMap.set(key, rollup);
  }
  for (const [key, rollup] of assigneeMap.entries()) {
    const series = perPersonDaily.get(key) ?? [];
    let peak = 0;
    let peakDate: string | null = null;
    let over = 0;
    days.forEach((day, index) => {
      const value = series[index] ?? 0;
      if (value > peak) {
        peak = value;
        peakDate = day.date;
      }
      if (day.working && value > 1.0001) over += 1;
    });
    const workingCount = Math.max(1, workingDays.length);
    rollup.peak_fte = round(peak);
    rollup.peak_date = peakDate;
    rollup.avg_fte = round(rollup.fte_days / workingCount);
    rollup.variance_fte = round(rollup.available_fte - rollup.avg_fte);
    rollup.over_days = over;
  }
  const by_assignee = [...assigneeMap.values()].sort((a, b) => b.avg_fte - a.avg_fte);

  const groupMap = new Map<string, FteGroupRollup>();
  for (const row of rows) {
    const existing =
      groupMap.get(row.group) ?? { group: row.group, colour: row.colour, activities: 0, fte_days: 0, share: 0 };
    existing.activities += 1;
    existing.fte_days = round(existing.fte_days + row.total_fte_days);
    groupMap.set(row.group, existing);
  }
  const by_group = [...groupMap.values()]
    .map((g) => ({ ...g, share: fteDays ? Math.round((g.fte_days / fteDays) * 100) : 0 }))
    .sort((a, b) => b.fte_days - a.fte_days);

  const unscheduled = listActivities(viewer, { departmentId: departmentId ?? undefined }).filter(
    (a) => a.active === 1 && !a.scheduled
  ).length;

  const workingCount = Math.max(1, workingDays.length);
  const releaseRows = rows.filter((row) => row.kind === "release");
  const totals: FteTotals = {
    activities: rows.length - releaseRows.length,
    releases: releaseRows.length,
    release_fte_days: round(releaseRows.reduce((sum, row) => sum + row.total_fte_working, 0)),
    people: new Set(rows.map((r) => r.assignee_id).filter(Boolean)).size,
    fte_days: fteDays,
    fte_days_working: fteDaysWorking,
    hours: round(fteDaysWorking * settings.hoursPerDay),
    avg_daily_fte: round(fteDaysWorking / workingCount),
    peak_fte: round(peakFte),
    peak_dates: peakDates,
    supply_fte_days: supplyFteDays,
    unavailable_fte_days: unavailableFteDays,
    variance_fte_days: varianceFteDays,
    /** Fractional FTE needed on an average working day (0.5 = one person half-time). */
    required_headcount_avg: round(fteDaysWorking / workingCount),
    /** Whole people needed on the busiest day. */
    required_headcount_peak: headcountFor(peakFte),
    headcount,
    working_days: workingDays.length,
    calendar_days: days.length,
    over_days: overDays,
    idle_days: idleDays,
    unscheduled,
  };

  const departmentName = departmentId ? viewer.org.deptById.get(departmentId)?.name ?? "All departments" : "All departments";

  return {
    range,
    monthKey: start.slice(0, 7),
    quarter,
    label:
      range === "quarter"
        ? `Q${quarter} · ${monthLabel(start)} – ${monthLabel(days[days.length - 1].date)}`
        : monthLabel(start),
    start,
    end,
    days,
    rows,
    daily_totals,
    daily_activity_counts,
    totals,
    by_assignee,
    by_group,
    scope: {
      department_id: departmentId,
      department_name: departmentName,
      group: filters.group ?? null,
      assignee_id: filters.assigneeId ?? null,
      testing_only: testingOnly,
      search: filters.search?.trim() ?? "",
    },
    hoursPerDay: settings.hoursPerDay,
  };
}

/** FTE required on a single day for one activity (pure, unit-tested). */
export function dailyFte(activity: { start_date: string | null; end_date: string | null }, fte: number, date: string) {
  if (!activity.start_date || !activity.end_date) return 0;
  return activity.start_date <= date && activity.end_date >= date ? fte : 0;
}

/** Whole people needed to cover a demand figure (1.2 FTE needs 2 people). */
export function headcountFor(fteDemand: number): number {
  if (fteDemand <= 0) return 0;
  return Math.ceil(fteDemand);
}

export function activityGroups(companyId?: string | null): string[] {
  const rows = all<{ activity_group: string }>(
    companyId
      ? `SELECT DISTINCT activity_group FROM activities WHERE company_id = ? AND active = 1 ORDER BY activity_group`
      : `SELECT DISTINCT activity_group FROM activities WHERE active = 1 ORDER BY activity_group`,
    ...(companyId ? [companyId] : [])
  );
  return rows.map((r) => r.activity_group);
}

export type FteActivityLite = Pick<
  ActivityView,
  "id" | "activity" | "start_date" | "end_date" | "effective_fte" | "activity_group" | "active"
>;

/** Pure helper: day-by-day demand series for a set of activities. */
export function demandSeries(activities: FteActivityLite[], days: string[]): number[] {
  return days.map((date) =>
    round(activities.filter((a) => a.active === 1).reduce((sum, a) => sum + dailyFte(a, a.effective_fte, date), 0))
  );
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
