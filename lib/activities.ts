import { all, get, json, run } from "./db";
import { appSettings } from "./settings";
import { departmentScope, tenantId, type Viewer } from "./access";
import { inclusiveDays, isValidRange } from "./dates";

export type Activity = {
  id: string;
  code: string | null;
  department_id: string | null;
  company_id: string | null;
  project_name: string | null;
  copy_batch_id?: string | null;
  activity: string;
  detail: string | null;
  activity_group: string;
  rule_type: string | null;
  active: number;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  fte: number;
  fte_override: number | null;
  colour: string;
  assignee_id: string | null;
  status: string;
  notes: string | null;
  data_quality: string | null;
  calendar_item_id: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  progress_percent: number;
  priority: string;
  is_demo: number;
  source_sheet: string | null;
  source_row: number | null;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityView = Activity & {
  assignee_name: string;
  department_name: string;
  department_colour: string;
  derived_progress: number;
  bug_counts: { reported: number; fixed: number; closed: number; outstanding: number };
  effective_fte: number;
  scheduled: boolean;
};

export function resolveFte(
  activity: Pick<Activity, "activity_group" | "fte" | "fte_override">,
  settings = appSettings()
): number {
  // Precedence: explicit per-record override → Regression default (1) →
  // stored FTE for non-Regression work → configured default (0.5).
  if (activity.fte_override !== null && activity.fte_override !== undefined) return activity.fte_override;
  if (activity.activity_group === "Regression") return settings.fteRegression;
  if (activity.fte !== null && activity.fte !== undefined && activity.fte > 0) return activity.fte;
  return settings.fteDefault;
}

/**
 * Effort conversion. The source workbook converts hours with an 8-hour day in
 * places, while capacity defaults to 7.6. We expose it as a setting and never
 * invent hours — 4h is 0.5 FTE at 8h/day and ~0.53 at 7.6h/day.
 */
export function fteFromHours(hours: number, hoursPerDay = appSettings().hoursPerDay): number {
  if (!hoursPerDay || hours <= 0) return 0;
  return Math.round((hours / hoursPerDay) * 100) / 100;
}

export function hoursFromFte(fte: number, hoursPerDay = appSettings().hoursPerDay): number {
  return Math.round(fte * hoursPerDay * 100) / 100;
}

export function bugCountsFor(activityIds: string[], companyId?: string | null) {
  if (!activityIds.length) return new Map<string, { reported: number; fixed: number; closed: number; outstanding: number }>();
  const rows = all<{ activity_id: string; reported: number; fixed: number; closed: number }>(
    `SELECT activity_id,
            COUNT(*) AS reported,
            SUM(CASE WHEN status = 'Fixed' THEN 1 ELSE 0 END) AS fixed,
            SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closed
       FROM bugs
      WHERE activity_id IN (${activityIds.map(() => "?").join(",")})
        ${companyId ? "AND company_id = ?" : ""}
      GROUP BY activity_id`,
    ...activityIds,
    ...(companyId ? [companyId] : [])
  );
  const map = new Map<string, { reported: number; fixed: number; closed: number; outstanding: number }>();
  for (const row of rows) {
    const outstanding = row.reported - row.fixed - row.closed;
    map.set(row.activity_id, {
      reported: row.reported,
      fixed: row.fixed,
      closed: row.closed,
      outstanding,
    });
  }
  return map;
}

/** Derived completion: closed = 100%, fixed = 75%, open = 0%. Documented in docs/DECISIONS.md. */
export function derivedProgress(counts?: { reported: number; fixed: number; closed: number }) {
  if (!counts || counts.reported === 0) return 0;
  const score = counts.closed + counts.fixed * 0.75;
  return Math.round((score / counts.reported) * 100);
}

/**
 * Tenant + department + person visibility for activities.
 *
 * The company clause is unconditional — even an application administrator sees
 * only the selected tenant. A department selection narrows further; an empty
 * selection means every department the viewer is authorised for.
 */
export function visibilitySql(viewer: Viewer): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const company = tenantId(viewer);
  const parts: string[] = ["a.company_id = ?"];
  params.push(company);

  const selected = departmentScope(viewer);
  const restrictDepartments = selected.length > 0 && selected.length < viewer.departmentIds.size;
  const deptClause = restrictDepartments
    ? `a.department_id IN (${selected.map(() => "?").join(",")})`
    : null;

  if (viewer.canSeeAll) {
    if (deptClause) {
      parts.push(deptClause);
      params.push(...selected);
    }
    return { clause: `(${parts.join(" AND ")})`, params };
  }
  const personIds = [...viewer.personIds];
  const own: string[] = [];
  if (personIds.length) {
    own.push(`a.assignee_id IN (${personIds.map(() => "?").join(",")})`);
    params.push(...personIds);
  }
  const depts = selected.length
    ? selected
    : viewer.actingAs.department_id && viewer.departmentIds.has(viewer.actingAs.department_id)
      ? [viewer.actingAs.department_id]
      : [];
  if (depts.length) {
    own.push(`(a.assignee_id IS NULL AND a.department_id IN (${depts.map(() => "?").join(",")}))`);
    params.push(...depts);
  }
  own.push("1=0");
  parts.push(`(${own.join(" OR ")})`);
  return { clause: `(${parts.join(" AND ")})`, params };
}

export function listActivities(
  viewer: Viewer,
  opts: {
    includeInactive?: boolean;
    from?: string;
    to?: string;
    assigneeId?: string;
    departmentId?: string;
    group?: string;
    search?: string;
    limit?: number;
  } = {}
): ActivityView[] {
  const vis = visibilitySql(viewer);
  const where: string[] = [vis.clause];
  const params: unknown[] = [...vis.params];
  if (!opts.includeInactive) where.push("a.active = 1");
  if (opts.from && opts.to) {
    where.push("a.start_date IS NOT NULL AND a.end_date IS NOT NULL AND a.start_date <= ? AND a.end_date >= ?");
    params.push(opts.to, opts.from);
  }
  if (opts.assigneeId) {
    where.push("a.assignee_id = ?");
    params.push(opts.assigneeId);
  }
  if (opts.departmentId) {
    where.push("a.department_id = ?");
    params.push(opts.departmentId);
  }
  if (opts.group) {
    where.push("a.activity_group = ?");
    params.push(opts.group);
  }
  if (opts.search) {
    where.push(
      "(LOWER(a.activity) LIKE ? OR LOWER(COALESCE(a.detail,'')) LIKE ? OR LOWER(COALESCE(a.code,'')) LIKE ? OR LOWER(COALESCE(a.project_name,'')) LIKE ?)"
    );
    const term = `%${opts.search.toLowerCase()}%`;
    params.push(term, term, term, term);
  }
  const limit = opts.limit ?? 500;
  const rows = all<Activity & { assignee_name: string | null; department_name: string | null; department_colour: string | null }>(
    `SELECT a.*, p.name AS assignee_name, d.name AS department_name, d.colour AS department_colour
       FROM activities a
       LEFT JOIN people p ON p.id = a.assignee_id
       LEFT JOIN departments d ON d.id = a.department_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(a.start_date, '9999-12-31'), a.activity
      LIMIT ?`,
    ...params,
    limit
  );
  const counts = bugCountsFor(rows.map((r) => r.id), tenantId(viewer));
  return rows.map((row) => {
    const bug_counts = counts.get(row.id) ?? { reported: 0, fixed: 0, closed: 0, outstanding: 0 };
    return {
      ...row,
      assignee_name: row.assignee_name ?? "Unassigned",
      department_name: row.department_name ?? "—",
      department_colour: row.department_colour ?? "#64748b",
      bug_counts,
      derived_progress: row.progress_percent || derivedProgress(bug_counts),
      effective_fte: resolveFte(row as Activity),
      scheduled: isValidRange(row.start_date, row.end_date),
    };
  });
}

export function getActivity(viewer: Viewer, id: string): ActivityView | null {
  const rows = listActivities(viewer, { includeInactive: true, limit: 1000 });
  return rows.find((r) => r.id === id) ?? null;
}

export function activitySummary(viewer: Viewer, from: string, to: string) {
  const activities = listActivities(viewer, { from, to });
  const active = activities.filter((a) => a.active === 1 && a.scheduled);
  const fteDemand = active.reduce((sum, a) => sum + a.effective_fte, 0);
  const avgProgress = active.length
    ? Math.round(active.reduce((sum, a) => sum + a.derived_progress, 0) / active.length)
    : 0;
  const byStatus = active.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  const byGroup = active.reduce<Record<string, number>>((acc, a) => {
    acc[a.activity_group] = (acc[a.activity_group] ?? 0) + 1;
    return acc;
  }, {});
  const bugs = all<{ reported: number; fixed: number; closed: number; outstanding: number }>(
    `SELECT COUNT(*) AS reported,
            SUM(CASE WHEN status = 'Fixed' THEN 1 ELSE 0 END) AS fixed,
            SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS outstanding
       FROM bugs WHERE company_id = ?`,
    tenantId(viewer)
  )[0] ?? { reported: 0, fixed: 0, closed: 0, outstanding: 0 };
  return {
    activities,
    activeCount: active.length,
    totalCount: activities.length,
    fteDemand: Math.round(fteDemand * 100) / 100,
    avgProgress,
    byStatus,
    byGroup,
    bugTotals: {
      reported: bugs.reported ?? 0,
      fixed: bugs.fixed ?? 0,
      closed: bugs.closed ?? 0,
      outstanding: bugs.outstanding ?? 0,
    },
    unscheduled: activities.filter((a) => !a.scheduled).length,
  };
}
