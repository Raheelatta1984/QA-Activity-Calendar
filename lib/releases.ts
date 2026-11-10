import { all, get, run } from "./db";
import { departmentScope, tenantId, type Viewer } from "./access";
import { eachDay, inclusiveDays, isIsoDate, isValidRange, isoToday, isWorkingDay } from "./dates";
import { holidayMap } from "./pipeline";
import { appSettings } from "./settings";
import { uid } from "./ids";

/**
 * Release planning — QA window, assignees and derived FTE.
 *
 * Why this module exists
 * ----------------------
 * A release date alone cannot be resourced. QA effort is a *window* of days
 * worked by a set of *people*; the same numbers must appear in three places so
 * the plan, the calendar and the capacity view can never disagree:
 *
 *   1. `tab.releases` — window, assignees, working days, FTE-days and hours.
 *   2. `tab.calendar` (QA calendar) — a bar per release window.
 *   3. `tab.fte` (FTE calendar) — one demand row per assignee, so the daily
 *      totals, per-person roll-ups and over-allocation flags include release
 *      work instead of quietly ignoring it.
 *
 * Rules (kept identical to `lib/fte.ts`)
 *   * Dates are inclusive date-only values; NULL means "not planned".
 *   * Only Monday–Friday days that are not NSW public holidays count as
 *     working days. Weekends and holidays are shown on the calendars but never
 *     inflate FTE-days.
 *   * FTE per assignee is demand *per working day*; FTE-days = Σ FTE × working
 *     days. Hours use the configured hours-per-day (7.6 by default).
 *   * A release with a window but no assignees is a real, visible gap: it counts
 *     as a warning, never as zero effort that looks planned.
 */

export const RELEASE_GROUP = "Release";
export const RELEASE_COLOUR = "#a855f7";

export type ReleaseAssignee = {
  id: string;
  person_id: string;
  name: string;
  title: string | null;
  colour: string;
  department_id: string | null;
  department_name: string;
  role: string;
  fte: number;
};

export type ReleasePlanStatus = "No window" | "Invalid window" | "Scheduled" | "In progress" | "Complete";

export type ReleasePlan = {
  id: string;
  version: string;
  kind: string;
  /** Release (deployment) date — the feed date, unchanged. */
  date: string | null;
  notes: string | null;
  link: string | null;
  link_verified: number;
  department_id: string | null;
  department_name: string;
  department_colour: string;
  qa_start_date: string | null;
  qa_end_date: string | null;
  qa_owner_id: string | null;
  /** Inclusive calendar days inside the window (0 when unplanned/invalid). */
  calendar_days: number;
  /** Monday–Friday days minus NSW public holidays inside the window. */
  working_days: number;
  /** Σ assignee FTE — demand carried on every working day of the window. */
  fte_per_day: number;
  /** Σ assignee FTE × working days. */
  fte_days: number;
  hours: number;
  assignees: ReleaseAssignee[];
  assignee_count: number;
  status: ReleasePlanStatus;
  scheduled: boolean;
  /** Machine-readable flags surfaced in the UI and the validation queue. */
  warnings: string[];
  /** Working-day dates in the window (used by the calendar tool-tips). */
  working_dates: string[];
};

export type ReleaseFteTotals = {
  releases: number;
  scheduled: number;
  invalid: number;
  unplanned: number;
  unassigned: number;
  assignees: number;
  working_days: number;
  fte_days: number;
  hours: number;
  peak_fte_per_day: number;
};

export type ReleaseBar = {
  release_id: string;
  version: string;
  kind: string;
  start_date: string;
  end_date: string;
  colour: string;
  status: ReleasePlanStatus;
  assignee_names: string;
  assignee_ids: string[];
  fte_per_day: number;
  working_days: number;
  fte_days: number;
};

export type ReleaseDemandRow = {
  /** Synthetic, stable id — never an activities.id. */
  id: string;
  release_id: string;
  version: string;
  activity: string;
  detail: string | null;
  group: typeof RELEASE_GROUP;
  colour: string;
  status: string;
  priority: string;
  department_id: string | null;
  department_name: string;
  department_colour: string;
  assignee_id: string | null;
  assignee_name: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  fte: number;
  progress: number;
};

export type ReleaseFilters = {
  /** Only releases whose window overlaps [from, to]. */
  from?: string;
  to?: string;
  departmentId?: string | null;
  personId?: string | null;
  /** Include releases that have no QA window yet (default false). */
  includeUnplanned?: boolean;
};

/** Working-day dates (Mon–Fri, excluding NSW holidays) between two inclusive dates. */
export function workingDatesBetween(start: string, end: string, holidays: Set<string> = new Set()) {
  if (!isValidRange(start, end)) return [];
  return eachDay(start, end).filter((date) => isWorkingDay(date, holidays));
}

function releaseStatus(plan: { qa_start_date: string | null; qa_end_date: string | null }, today: string): ReleasePlanStatus {
  if (!plan.qa_start_date && !plan.qa_end_date) return "No window";
  if (!isValidRange(plan.qa_start_date, plan.qa_end_date)) return "Invalid window";
  if (plan.qa_end_date! < today) return "Complete";
  if (plan.qa_start_date! <= today) return "In progress";
  return "Scheduled";
}

/**
 * Row-level visibility: holistic roles see every release; everyone else sees a
 * release when it belongs to one of their departments or one of its assignees is
 * in their downward sub-tree. A release is never hidden from a person who is
 * assigned to it.
 */
function visibleTo(viewer: Viewer, row: { department_id: string | null }, assignees: ReleaseAssignee[]) {
  if (viewer.canSeeAll) return true;
  if (row.department_id && viewer.departmentIds.has(row.department_id)) return true;
  return assignees.some((a) => viewer.personIds.has(a.person_id));
}

export function listReleasePlans(viewer: Viewer, filters: ReleaseFilters = {}): ReleasePlan[] {
  const settings = appSettings();
  const today = isoToday();
  const holidays = new Set(holidayMap().keys());

  const companyId = tenantId(viewer);
  const releases = all<{
    id: string;
    company_id: string | null;
    version: string;
    kind: string;
    date: string | null;
    notes: string | null;
    link: string | null;
    link_verified: number;
    department_id: string | null;
    department_name: string | null;
    department_colour: string | null;
    qa_start_date: string | null;
    qa_end_date: string | null;
    qa_owner_id: string | null;
  }>(
    `SELECT r.id, r.company_id, r.version, r.kind, r.date, r.notes, r.link, r.link_verified, r.department_id,
            r.qa_start_date, r.qa_end_date, r.qa_owner_id,
            d.name AS department_name, d.colour AS department_colour
       FROM release_feed r
       LEFT JOIN departments d ON d.id = r.department_id
      WHERE r.company_id = ?
      ORDER BY COALESCE(NULLIF(r.qa_start_date, ''), NULLIF(r.date, ''), '9999-12-31'), r.version`,
    companyId
  );

  if (!releases.length) return [];

  const assignments = all<{
    id: string;
    release_id: string;
    person_id: string;
    role: string;
    fte: number;
    name: string;
    title: string | null;
    colour: string | null;
    department_id: string | null;
    department_name: string | null;
  }>(
    `SELECT ra.id, ra.release_id, ra.person_id, ra.role, ra.fte,
            p.name, p.title, p.colour, p.department_id, d.name AS department_name
       FROM release_assignees ra
       JOIN people p ON p.id = ra.person_id
       JOIN departments d ON d.id = p.department_id
      WHERE d.company_id = ?
      ORDER BY p.name`,
    companyId
  );
  const byRelease = new Map<string, ReleaseAssignee[]>();
  for (const row of assignments) {
    const list = byRelease.get(row.release_id) ?? [];
    list.push({
      id: row.id,
      person_id: row.person_id,
      name: row.name,
      title: row.title,
      colour: row.colour ?? "#8b9dc3",
      department_id: row.department_id,
      department_name: row.department_name ?? "—",
      role: row.role,
      fte: Number(row.fte ?? 0),
    });
    byRelease.set(row.release_id, list);
  }

  const plans: ReleasePlan[] = [];
  for (const release of releases) {
    const assignees = byRelease.get(release.id) ?? [];
    if (release.company_id && release.company_id !== companyId) continue;
    if (!visibleTo(viewer, release, assignees)) continue;
    const selectedDepartments = departmentScope(viewer);
    const restrictDepartments =
      selectedDepartments.length > 0 && selectedDepartments.length < viewer.departmentIds.size;
    if (restrictDepartments && !selectedDepartments.includes(release.department_id ?? "")) continue;
    if (filters.personId && !assignees.some((a) => a.person_id === filters.personId)) continue;
    if (filters.departmentId && release.department_id !== filters.departmentId) continue;
    const planned = isValidRange(release.qa_start_date, release.qa_end_date);
    if (
      !filters.includeUnplanned &&
      (filters.from || filters.to) &&
      !(planned && release.qa_start_date! <= (filters.to ?? "9999-12-31") && release.qa_end_date! >= (filters.from ?? "0000-01-01"))
    ) {
      continue;
    }

    const workingDates = planned ? workingDatesBetween(release.qa_start_date!, release.qa_end_date!, holidays) : [];
    const ftePerDay = round(assignees.reduce((sum, a) => sum + (Number.isFinite(a.fte) ? a.fte : 0), 0));
    const fteDays = round(ftePerDay * workingDates.length);
    const status = releaseStatus(release, today);

    const warnings: string[] = [];
    if (!release.qa_start_date && !release.qa_end_date) {
      warnings.push("No QA window — this release cannot be resourced or shown on a calendar.");
    } else if (!planned) {
      warnings.push("QA window is incomplete or the end date is before the start date.");
    }
    if (planned && !workingDates.length) {
      warnings.push("QA window contains no working days (weekends and/or NSW public holidays only).");
    }
    if (planned && !assignees.length) {
      warnings.push("QA window has no assignees — effort is unknown, not zero.");
    }
    if (planned && assignees.length && ftePerDay <= 0) {
      warnings.push("Assignees are recorded with 0 FTE — effort is unknown, not zero.");
    }
    if (planned && isIsoDate(release.date) && release.date! < release.qa_end_date!) {
      warnings.push(`QA window ends ${release.qa_end_date} after the release date ${release.date} — confirm the plan.`);
    }

    plans.push({
      ...release,
      department_name: release.department_name ?? "—",
      department_colour: release.department_colour ?? "#64748b",
      calendar_days: planned ? inclusiveDays(release.qa_start_date!, release.qa_end_date!) : 0,
      working_days: workingDates.length,
      working_dates: workingDates,
      fte_per_day: ftePerDay,
      fte_days: fteDays,
      hours: round(fteDays * settings.hoursPerDay),
      assignees,
      assignee_count: assignees.length,
      status,
      scheduled: planned,
      warnings,
    });
  }

  return plans;
}

export function getReleasePlan(viewer: Viewer, id: string): ReleasePlan | null {
  return listReleasePlans(viewer, { includeUnplanned: true }).find((plan) => plan.id === id) ?? null;
}

export function releaseFteTotals(plans: ReleasePlan[]): ReleaseFteTotals {
  const scheduled = plans.filter((plan) => plan.scheduled);
  const assigneeIds = new Set<string>();
  for (const plan of plans) plan.assignees.forEach((a) => assigneeIds.add(a.person_id));
  return {
    releases: plans.length,
    scheduled: scheduled.length,
    invalid: plans.filter((plan) => plan.status === "Invalid window").length,
    unplanned: plans.filter((plan) => plan.status === "No window").length,
    unassigned: scheduled.filter((plan) => plan.assignee_count === 0).length,
    assignees: assigneeIds.size,
    working_days: scheduled.reduce((sum, plan) => sum + plan.working_days, 0),
    fte_days: round(scheduled.reduce((sum, plan) => sum + plan.fte_days, 0)),
    hours: round(scheduled.reduce((sum, plan) => sum + plan.hours, 0)),
    peak_fte_per_day: round(Math.max(0, ...scheduled.map((plan) => plan.fte_per_day))),
  };
}

/**
 * One bar per release window for the QA calendar. Assignees are collapsed into a
 * label; per-person demand is `releaseDemandRows` (used by the FTE calendar).
 */
export function releaseBars(viewer: Viewer, from: string, to: string): ReleaseBar[] {
  return listReleasePlans(viewer, { from, to })
    .filter((plan) => plan.scheduled)
    .map((plan) => ({
      release_id: plan.id,
      version: plan.version,
      kind: plan.kind,
      start_date: plan.qa_start_date!,
      end_date: plan.qa_end_date!,
      colour: RELEASE_COLOUR,
      status: plan.status,
      assignee_names: plan.assignees.length ? plan.assignees.map((a) => a.name).join(", ") : "Unassigned",
      assignee_ids: plan.assignees.map((a) => a.person_id),
      fte_per_day: plan.fte_per_day,
      working_days: plan.working_days,
      fte_days: plan.fte_days,
    }));
}

/**
 * Release demand as calendar rows: one row per assignee (so per-person FTE is
 * honest). A release with a window but no assignees yields a single
 * "Unassigned" row with 0 FTE, which keeps the gap visible instead of
 * pretending the window does not exist.
 */
export function releaseDemandRows(viewer: Viewer, from: string, to: string): ReleaseDemandRow[] {
  const rows: ReleaseDemandRow[] = [];
  for (const plan of listReleasePlans(viewer, { from, to })) {
    if (!plan.scheduled) continue;
    const base = {
      release_id: plan.id,
      version: plan.version,
      activity: `Release ${plan.version} · QA window`,
      detail: plan.notes ?? `${plan.kind} release · QA window ${plan.qa_start_date} → ${plan.qa_end_date}`,
      group: RELEASE_GROUP as typeof RELEASE_GROUP,
      colour: RELEASE_COLOUR,
      status: plan.status === "Complete" ? "Complete" : plan.status === "In progress" ? "In Progress" : "Planned",
      priority: "Normal",
      department_id: plan.department_id,
      department_name: plan.department_name,
      department_colour: plan.department_colour,
      start_date: plan.qa_start_date!,
      end_date: plan.qa_end_date!,
      duration_days: plan.calendar_days,
      progress: plan.status === "Complete" ? 100 : plan.status === "In progress" ? 50 : 0,
    };
    if (!plan.assignees.length) {
      rows.push({
        ...base,
        id: `rel:${plan.id}:unassigned`,
        assignee_id: null,
        assignee_name: "Unassigned",
        fte: 0,
      });
      continue;
    }
    for (const assignee of plan.assignees) {
      rows.push({
        ...base,
        id: `rel:${plan.id}:${assignee.person_id}`,
        assignee_id: assignee.person_id,
        assignee_name: assignee.name,
        fte: round(assignee.fte),
      });
    }
  }
  return rows;
}

/** Releases whose window contains a date (used by day tool-tips). */
export function releasesOnDate(plans: ReleasePlan[], date: string) {
  return plans.filter((plan) => plan.scheduled && plan.qa_start_date! <= date && plan.qa_end_date! >= date);
}

/** Assignee options for the release planner: active people in the viewer's scope. */
export function assignablePeople(viewer: Viewer) {
  return viewer.org.people
    .filter((person) => !!person.active)
    .filter((person) => viewer.canSeeAll || viewer.personIds.has(person.id))
    .filter((person) => !person.department_id || viewer.departmentIds.has(person.department_id))
    .map((person) => ({
      id: person.id,
      name: person.name,
      title: person.title,
      colour: person.colour,
      department_id: person.department_id,
      department_name: viewer.org.deptById.get(person.department_id ?? "")?.name ?? "—",
    }));
}

/**
 * Replace a release's assignee rows without destroying assignments the editor
 * cannot see.
 *
 * The planner form only renders people inside the viewer's scope. Deleting
 * *every* row and re-inserting the submitted ones would silently drop an
 * assignee who fell outside that scope (a reorg, a disabled department, a
 * narrower role) — quiet data loss that later shows up as missing FTE. So only
 * people the editor was allowed to touch are replaced; everyone else is left
 * exactly as they were.
 *
 * Call inside a transaction. `selected` must already be validated (known
 * person, FTE > 0).
 */
export function syncReleaseAssignees(
  releaseId: string,
  allowedPersonIds: Set<string>,
  selected: Array<{ person_id: string; fte: number }>
) {
  const allowed = [...allowedPersonIds];
  const keep = selected.filter((person) => allowedPersonIds.has(person.person_id));

  if (allowed.length) {
    const inScope = allowed.map(() => "?").join(", ");
    if (keep.length) {
      run(
        `DELETE FROM release_assignees
          WHERE release_id = ? AND person_id IN (${inScope})
            AND person_id NOT IN (${keep.map(() => "?").join(", ")})`,
        releaseId,
        ...allowed,
        ...keep.map((person) => person.person_id)
      );
    } else {
      run(`DELETE FROM release_assignees WHERE release_id = ? AND person_id IN (${inScope})`, releaseId, ...allowed);
    }
  }

  for (const person of keep) {
    run(
      `INSERT INTO release_assignees (id, release_id, person_id, role, fte) VALUES (?, ?, ?, 'QA', ?)
       ON CONFLICT(release_id, person_id) DO UPDATE SET fte = excluded.fte, role = excluded.role`,
      uid("rla"),
      releaseId,
      person.person_id,
      round(person.fte)
    );
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

/** Guard used by the server action and the bootstrap demo data. */
export function releaseExists(id: string, companyId?: string | null) {
  return !!get<{ id: string }>(
    `SELECT id FROM release_feed WHERE id = ?${companyId ? " AND company_id = ?" : ""}`,
    id,
    ...(companyId ? [companyId] : [])
  );
}
