import { all, get } from "./db";
import type { Viewer } from "./access";
import { addDays, diffDays, eachDay, inclusiveDays, isIsoDate, isWorkingDay, isValidRange } from "./dates";
import { visibilitySql } from "./activities";

export type PipelineView = {
  id: string;
  code: string | null;
  department_id: string | null;
  activity: string;
  detail: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  duration_days: number | null;
  effective_start: string | null;
  effective_end: string | null;
  effective_duration: number | null;
  recording_status: string;
  current_status: string;
  automation_percent: number;
  blocker: string | null;
  colour: string;
  assignee_id: string | null;
  assignee_name: string;
  is_test: number;
  notes: string | null;
  source_sheet: string | null;
  source_row: number | null;
  eligible_days: number;
  blocked_days: string[];
  exclusions: { date: string; reason: string }[];
  warnings: string[];
  blocked_by_qa: { id: string; activity: string }[];
};

/** Later of planned/actual start; later of planned/actual end (source parity). */
export function effectiveRange(item: {
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
}) {
  const starts = [item.planned_start, item.actual_start].filter((v): v is string => isIsoDate(v));
  const ends = [item.planned_end, item.actual_end].filter((v): v is string => isIsoDate(v));
  const start = starts.length ? starts.sort().at(-1)! : null;
  const end = ends.length ? ends.sort().at(-1)! : null;
  return {
    start,
    end,
    duration: isValidRange(start, end) ? inclusiveDays(start!, end!) : null,
  };
}

export function holidayMap(): Map<string, string> {
  const rows = all<{ date: string; name: string }>(`SELECT date, name FROM holidays`);
  return new Map(rows.map((r) => [r.date, r.name]));
}

export function listExclusions() {
  return all<{ id: string; pipeline_id: string | null; date: string; reason: string; created_at: string; created_by: string | null }>(
    `SELECT e.*, p.name AS created_by_name FROM pipeline_exclusions e
       LEFT JOIN people p ON p.id = e.created_by ORDER BY e.date`
  );
}

export function listPipeline(viewer: Viewer): PipelineView[] {
  const vis = visibilitySql(viewer);
  const holidays = holidayMap();
  const exclusions = all<{ id: string; pipeline_id: string | null; date: string; reason: string }>(
    `SELECT id, pipeline_id, date, reason FROM pipeline_exclusions`
  );
  const activeQa = all<{ id: string; activity: string; start_date: string; end_date: string; assignee_id: string | null; department_id: string | null }>(
    `SELECT id, activity, start_date, end_date, assignee_id, department_id FROM activities
      WHERE active = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL`
  ).filter((a) => {
    // apply the same person/department visibility to blocking activities
    if (viewer.canSeeAll) return true;
    if (a.assignee_id) return viewer.personIds.has(a.assignee_id);
    return !!a.department_id && viewer.departmentIds.has(a.department_id);
  });

  const items = all<any>(
    `SELECT r.*, p.name AS assignee_name
       FROM recording_pipeline r
       LEFT JOIN people p ON p.id = r.assignee_id
      ORDER BY COALESCE(r.planned_start, '9999-12-31'), r.activity`
  );

  return items.map((item) => {
    const eff = effectiveRange(item);
    const allExclusions = [
      ...new Map(
        exclusions
          .filter((e) => e.pipeline_id === item.id || e.pipeline_id === null)
          .map((e) => [e.date, e])
      ).values(),
    ];

    const days = eff.start && eff.end ? eachDay(eff.start, eff.end) : [];
    const blockedDates: string[] = [];
    const blockedByQa = new Map<string, { id: string; activity: string }>();
    let eligible = 0;
    for (const day of days) {
      if (!isWorkingDay(day, new Set(holidays.keys()))) continue;
      if (allExclusions.some((e) => e.date === day)) continue;
      const overlap = activeQa.filter(
        (a) => a.start_date! <= day && a.end_date! >= day
      );
      if (overlap.length) {
        blockedDates.push(day);
        overlap.forEach((a) => blockedByQa.set(a.id, { id: a.id, activity: a.activity }));
        continue;
      }
      eligible += 1;
    }

    const warnings: string[] = [];
    if (item.is_test) warnings.push("TEST record — demo data, excluded from operational KPIs.");
    if (!eff.start || !eff.end) warnings.push("Missing or invalid dates — cannot schedule.");
    if (!isValidRange(item.planned_start, item.planned_end) && !isValidRange(item.actual_start, item.actual_end)) {
      warnings.push("No valid planned or actual range.");
    }
    if (item.current_status === "Blocked" && !item.blocker) warnings.push("Marked blocked without a blocker reason.");
    if (item.blocker && item.current_status !== "Blocked") warnings.push("Blocker recorded but status is not Blocked.");
    if (blockedDates.length) warnings.push(`${blockedDates.length} day(s) blocked by Active QA overlap.`);
    if (allExclusions.length) warnings.push(`${allExclusions.length} manual exclusion(s) applied.`);
    if (item.automation_percent >= 100 && item.recording_status !== "Complete") {
      warnings.push("Automation at 100% but recording not marked complete.");
    }

    return {
      ...item,
      effective_start: eff.start,
      effective_end: eff.end,
      effective_duration: eff.duration,
      assignee_name: item.assignee_name ?? "Unassigned",
      eligible_days: eligible,
      blocked_days: blockedDates,
      exclusions: allExclusions.map((e) => ({ date: e.date, reason: e.reason })),
      warnings,
      blocked_by_qa: [...blockedByQa.values()],
    } as PipelineView;
  });
}

export type AvailabilityDay = {
  date: string;
  weekday: number;
  status: "eligible" | "weekend" | "holiday" | "excluded" | "blocked";
  label?: string;
};

export function availabilityWindow(start: string, end: string, pipelineId?: string): AvailabilityDay[] {
  const holidays = holidayMap();
  const exclusions = all<{ pipeline_id: string | null; date: string; reason: string }>(
    `SELECT pipeline_id, date, reason FROM pipeline_exclusions
      WHERE pipeline_id IS NULL ${pipelineId ? "OR pipeline_id = ?" : ""}`,
    ...(pipelineId ? [pipelineId] : [])
  );
  const activeQa = all<{ id: string; activity: string; start_date: string; end_date: string }>(
    `SELECT id, activity, start_date, end_date FROM activities
      WHERE active = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL`
  );
  return eachDay(start, end).map((date) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!isWorkingDay(date, new Set())) return { date, weekday, status: "weekend" as const };
    if (holidays.has(date)) return { date, weekday, status: "holiday" as const, label: holidays.get(date) };
    const exclusion = exclusions.find((e) => e.date === date);
    if (exclusion) return { date, weekday, status: "excluded" as const, label: exclusion.reason };
    const overlap = activeQa.find((a) => a.start_date <= date && a.end_date >= date);
    if (overlap) return { date, weekday, status: "blocked" as const, label: overlap.activity };
    return { date, weekday, status: "eligible" as const };
  });
}

export function pipelineStats(items: PipelineView[]) {
  const operational = items.filter((i) => !i.is_test);
  const eligible = operational.reduce((s, i) => s + i.eligible_days, 0);
  const blocked = operational.reduce((s, i) => s + i.blocked_days.length, 0);
  const complete = operational.filter(
    (i) => i.recording_status === "Complete" || i.recording_status === "Recorded" || i.current_status === "Complete"
  ).length;
  const avgAutomation = operational.length
    ? Math.round(operational.reduce((s, i) => s + i.automation_percent, 0) / operational.length)
    : 0;
  return {
    total: operational.length,
    test: items.length - operational.length,
    complete,
    eligible,
    blocked,
    avgAutomation,
    warnings: operational.reduce((s, i) => s + i.warnings.length, 0),
  };
}

export function pipelineItemsForRange(viewer: Viewer, from: string, to: string) {
  const all_ = listPipeline(viewer);
  return all_.filter((item) => {
    if (!item.effective_start || !item.effective_end) return false;
    return item.effective_start <= to && item.effective_end >= from;
  });
}

export function daySpan(start: string, end: string) {
  return diffDays(start, end) + 1;
}

export { addDays };
