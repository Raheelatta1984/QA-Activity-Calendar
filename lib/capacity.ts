import { all } from "./db";
import type { Viewer } from "./access";
import { addDays, eachDay, isWorkingDay, monthStart, monthLabel, addMonths, isoToday, toUtc } from "./dates";
import { listActivities } from "./activities";
import { holidayMap } from "./pipeline";
import { appSettings } from "./settings";

export type CapacityCell = {
  person_id: string;
  date: string;
  not_available_hours: number;
  devops_hours: number;
  recording_hours: number;
  qa_testing_hours: number;
  total_hours: number;
  note: string | null;
  source: string | null;
};

export type PersonCapacity = {
  person_id: string;
  name: string;
  colour: string;
  department_name: string;
  title: string | null;
  role: string;
  default_hours: number;
  working_days: number;
  total_hours: number;
  not_available: number;
  devops: number;
  recording: number;
  qa_testing: number;
  occupied: number;
  utilisation: number;
  productive_utilisation: number;
  fte_demand: number;
  over_allocated_days: { date: string; fte: number }[];
  cells: CapacityCell[];
  days_without_entry: string[];
};

export type CapacityMonth = {
  monthKey: string;
  label: string;
  start: string;
  end: string;
  days: string[];
  holidays: Map<string, string>;
  people: PersonCapacity[];
  totals: {
    total_hours: number;
    occupied: number;
    utilisation: number;
    fte_demand: number;
    working_days: number;
    fteCapacity: number;
  };
};

export function monthDays(monthKey: string): string[] {
  const start = monthStart(monthKey);
  const next = addMonths(start, 1);
  return eachDay(start, addDays(next, -1));
}

export function capacityMonth(viewer: Viewer, monthKey?: string): CapacityMonth {
  const now = isoToday();
  const key = monthKey ?? now.slice(0, 7);
  const days = monthDays(key);
  const holidayMapValue = holidayMap();
  const workingDays = days.filter((day) => isWorkingDay(day, new Set(holidayMapValue.keys())));
  const settings = appSettings();

  const people = viewer.org.people
    .filter((p) => !!p.active)
    .filter((p) => viewer.canSeeAll || viewer.personIds.has(p.id))
    .filter((p) => !p.department_id || viewer.departmentIds.has(p.department_id))
    .filter((p) => !viewer.activeDepartmentId || p.department_id === viewer.activeDepartmentId);

  const entries = all<CapacityCell & { person_id: string }>(
    `SELECT * FROM resource_day_capacity WHERE date >= ? AND date <= ?`,
    days[0],
    days[days.length - 1]
  );
  const byPersonDay = new Map<string, CapacityCell>();
  for (const e of entries) byPersonDay.set(`${e.person_id}|${e.date}`, e);

  const activities = listActivities(viewer, { from: days[0], to: days[days.length - 1] }).filter(
    (a) => a.active === 1 && a.scheduled
  );

  const result: PersonCapacity[] = people.map((person) => {
    const cells: CapacityCell[] = [];
    let totalHours = 0;
    let notAvailable = 0;
    let devops = 0;
    let recording = 0;
    let qa = 0;
    const missing: string[] = [];
    for (const day of workingDays) {
      const entry = byPersonDay.get(`${person.id}|${day}`);
      if (!entry) {
        missing.push(day);
        totalHours += person.capacity_hours_day || settings.hoursPerDay;
        continue;
      }
      cells.push(entry);
      totalHours += entry.total_hours;
      notAvailable += entry.not_available_hours;
      devops += entry.devops_hours;
      recording += entry.recording_hours;
      qa += entry.qa_testing_hours;
    }
    const occupied = notAvailable + devops + recording + qa;

    const fteByDay = new Map<string, number>();
    for (const day of workingDays) {
      const total = activities
        .filter((a) => a.assignee_id === person.id && a.start_date! <= day && a.end_date! >= day)
        .reduce((sum, a) => sum + a.effective_fte, 0);
      if (total > 0) fteByDay.set(day, Math.round(total * 100) / 100);
    }

    return {
      person_id: person.id,
      name: person.name,
      colour: person.colour,
      department_name: viewer.org.deptById.get(person.department_id ?? "")?.name ?? "—",
      title: person.title,
      role: person.role,
      default_hours: person.capacity_hours_day,
      working_days: workingDays.length,
      total_hours: round(totalHours),
      not_available: round(notAvailable),
      devops: round(devops),
      recording: round(recording),
      qa_testing: round(qa),
      occupied: round(occupied),
      utilisation: totalHours ? Math.round((occupied / totalHours) * 100) : 0,
      productive_utilisation: totalHours ? Math.round((qa / totalHours) * 100) : 0,
      fte_demand: round([...fteByDay.values()].reduce((s, v) => s + v, 0) / Math.max(1, workingDays.length)),
      over_allocated_days: [...fteByDay.entries()]
        .filter(([, fte]) => fte > 1)
        .map(([date, fte]) => ({ date, fte })),
      cells,
      days_without_entry: missing,
    };
  });

  const totalHours = result.reduce((s, p) => s + p.total_hours, 0);
  const occupied = result.reduce((s, p) => s + p.occupied, 0);
  return {
    monthKey: key,
    label: monthLabel(monthStart(key)),
    start: days[0],
    end: days[days.length - 1],
    days,
    holidays: holidayMapValue,
    people: result,
    totals: {
      total_hours: round(totalHours),
      occupied: round(occupied),
      utilisation: totalHours ? Math.round((occupied / totalHours) * 100) : 0,
      fte_demand: round(result.reduce((s, p) => s + p.fte_demand, 0)),
      working_days: workingDays.length,
      fteCapacity: result.length,
    },
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function capacityTrend(viewer: Viewer, months = 4) {
  const now = isoToday();
  const out: { monthKey: string; label: string; utilisation: number; fte: number; hours: number }[] = [];
  for (let i = 0; i < months; i += 1) {
    const key = addMonths(`${now.slice(0, 7)}-01`, i).slice(0, 7);
    const month = capacityMonth(viewer, key);
    out.push({
      monthKey: key,
      label: new Intl.DateTimeFormat("en-AU", { month: "short", timeZone: "UTC" }).format(toUtc(`${key}-01`)),
      utilisation: month.totals.utilisation,
      fte: month.totals.fte_demand,
      hours: month.totals.total_hours,
    });
  }
  return out;
}

export function demandByDay(viewer: Viewer, start: string, end: string) {
  const activities = listActivities(viewer, { from: start, to: end }).filter((a) => a.active === 1 && a.scheduled);
  return eachDay(start, end).map((date) => {
    const dayActivities = activities.filter((a) => a.start_date! <= date && a.end_date! >= date);
    return {
      date,
      fte: round(dayActivities.reduce((s, a) => s + a.effective_fte, 0)),
      count: dayActivities.length,
      working: isWorkingDay(date, new Set()),
    };
  });
}
