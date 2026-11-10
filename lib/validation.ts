import { all, get, run } from "./db";
import { uid } from "./ids";
import { addDays, diffDays, eachDay, isIsoDate, isWorkingDay, isoToday, isValidRange } from "./dates";

export type Issue = {
  severity: "error" | "warning" | "info";
  entity: string;
  entity_id: string | null;
  rule: string;
  message: string;
  /** Owning tenant; NULL only for legacy rows that predate tenant keys. */
  company_id?: string | null;
};

export const RULE_CATALOGUE: { rule: string; severity: string; description: string; parity?: string }[] = [
  {
    rule: "activity.missing_dates",
    severity: "warning",
    description: "Scheduled activity is missing a start or end date. It stays in the unscheduled queue and never renders on a calendar.",
    parity: "Blank template rows are separated from genuine unscheduled records.",
  },
  {
    rule: "activity.invalid_range",
    severity: "error",
    description: "Start date is after end date. Dates are inclusive, so a schedulable record needs start <= end.",
  },
  {
    rule: "activity.duplicate_code",
    severity: "warning",
    description: "Two activities share a Calendar Item ID. Repeated activity names are valid; duplicate IDs are not.",
  },
  {
    rule: "activity.unassigned",
    severity: "info",
    description: "Active scheduled activity has no assignee. Blank assignee displays as Unassigned, it is not an error.",
  },
  {
    rule: "activity.disabled_department",
    severity: "warning",
    description: "Active activity belongs to a disabled department and is excluded from operational views.",
  },
  {
    rule: "activity.assignment_review",
    severity: "warning",
    description: "Imported active activity carries a raw assignee label (e.g. 'Sudeep/Mukti') that has not been matched to a person — assignment needs human review, it is never auto-created.",
    parity: "Unresolved 'Assing To' labels stay visible until confirmed.",
  },
  {
    rule: "activity.fte_conflict",
    severity: "warning",
    description: "An assignee carries more than 1.0 FTE of active work on the same working day.",
  },
  {
    rule: "pipeline.missing_dates",
    severity: "warning",
    description: "Pipeline item has no usable planned or actual range, so eligibility cannot be computed.",
  },
  {
    rule: "pipeline.needs_confirmation",
    severity: "info",
    description: "TEST-labelled imported pipeline record preserved as-is, awaiting owner confirmation before being treated as operational.",
    parity: "TEST source labels are kept literally, never relabelled or deleted.",
  },
  {
    rule: "pipeline.blocked_without_reason",
    severity: "error",
    description: "Blocked recording without a blocker reason; the reason is required for progress reporting.",
  },
  {
    rule: "pipeline.test_record",
    severity: "info",
    description: "TEST records stay explicitly marked as demo/test and are excluded from operational KPIs.",
  },
  {
    rule: "pqu.chronology",
    severity: "warning",
    description: "PQU change cutoff or duration looks inconsistent. Flagged for a human, never silently corrected.",
  },
  {
    rule: "governance.go_without_regression",
    severity: "error",
    description: "A release is marked Go while regression has not passed. Approval is never inferred from a plan.",
  },
  {
    rule: "release.link_unverified",
    severity: "info",
    description: "Release feed link has not been verified. Links are never fetched or auto-executed.",
  },
  {
    rule: "release.qa_window_missing",
    severity: "info",
    description:
      "Release has no QA window (from/to). Without dates the release contributes no FTE to the QA or FTE calendar.",
  },
  {
    rule: "release.qa_window_invalid",
    severity: "error",
    description:
      "Release QA window is incomplete or ends before it starts. Dates are inclusive, so a resourced window needs start <= end.",
  },
  {
    rule: "release.qa_window_unassigned",
    severity: "warning",
    description:
      "Release QA window has no assignees. Release effort is unknown, not zero — assign at least one person with an FTE share.",
  },
  {
    rule: "release.qa_window_after_release",
    severity: "warning",
    description: "Release QA window ends after the release (deployment) date. Flagged for a human, never silently moved.",
  },
  {
    rule: "enhancement.missing_success",
    severity: "info",
    description: "Enhancement has no success criteria, so it cannot be accepted into the development pipeline.",
  },
  {
    rule: "capacity.missing_entry",
    severity: "info",
    description: "No capacity entry for a working day. Demand is unknown rather than assumed to be 8 hours.",
  },
  {
    rule: "capacity.assumed_eight_hours",
    severity: "info",
    description: "Capacity total is exactly 8 hours. Source allowed 7.6 or 4 — confirm this is intentional.",
  },
  {
    rule: "exclusion.no_reason",
    severity: "error",
    description: "Pipeline exclusion has no reason. Reasons are required for audit.",
  },
];

export function detectIssues(companyId?: string | null): Issue[] {
  const issues: Issue[] = [];
  const today = isoToday();
  const horizonEnd = addDays(today, 60);
  const scopedRows = <T extends { company_id?: string | null }>(rows: T[]): T[] =>
    companyId ? rows.filter((row) => row.company_id === companyId) : rows;

  const activities = scopedRows(all<any>(`SELECT * FROM activities`));
  const departmentRows = all<any>(`SELECT id, enabled, name, company_id FROM departments`);
  const departments = new Map(departmentRows.map((d) => [d.id, d]));

  const seenCodes = new Map<string, string[]>();
  for (const activity of activities) {
    if (!activity.start_date || !activity.end_date) {
      if (activity.active) {
        issues.push({
          severity: "warning",
          entity: "activity",
          entity_id: activity.id,
          rule: "activity.missing_dates",
          message: `${activity.activity} has no complete schedule — kept in the unscheduled queue.`,
        });
      }
    } else if (!isValidRange(activity.start_date, activity.end_date)) {
      issues.push({
        severity: "error",
        entity: "activity",
        entity_id: activity.id,
        rule: "activity.invalid_range",
        message: `${activity.activity}: start ${activity.start_date} is after end ${activity.end_date}.`,
      });
    }
    if (activity.code) {
      const list = seenCodes.get(activity.code) ?? [];
      list.push(activity.id);
      seenCodes.set(activity.code, list);
    }
    if (activity.active && activity.start_date && !activity.assignee_id) {
      issues.push({
        severity: "info",
        entity: "activity",
        entity_id: activity.id,
        rule: "activity.unassigned",
        message: `${activity.activity} is unassigned.`,
      });
    }
    const dept = activity.department_id ? departments.get(activity.department_id) : null;
    if (activity.active && dept && !dept.enabled) {
      issues.push({
        severity: "warning",
        entity: "activity",
        entity_id: activity.id,
        rule: "activity.disabled_department",
        message: `${activity.activity} sits in disabled department ${dept.name}.`,
      });
    }
  }
  for (const activity of activities) {
    const raw = typeof activity.source_assignee_text === "string" ? activity.source_assignee_text.trim() : "";
    if (activity.active && raw && !activity.assignee_id) {
      issues.push({
        severity: "warning",
        entity: "activity",
        entity_id: activity.id,
        rule: "activity.assignment_review",
        message: `${activity.activity}: assignee '${raw}' is not matched to a person — review assignment.`,
      });
    }
  }
  for (const [code, ids] of seenCodes) {
    if (ids.length > 1) {
      issues.push({
        severity: "warning",
        entity: "activity",
        entity_id: ids[0],
        rule: "activity.duplicate_code",
        message: `Calendar Item ID ${code} is used by ${ids.length} records.`,
      });
    }
  }

  // FTE conflicts per person/day in the next 60 days
  const activeScheduled = activities.filter(
    (a) => a.active && a.assignee_id && isValidRange(a.start_date, a.end_date) && a.start_date <= horizonEnd && a.end_date >= today
  );
  const conflictDays = new Map<string, { date: string; fte: number; names: string[] }>();
  for (const activity of activeScheduled) {
    const start = activity.start_date > today ? activity.start_date : today;
    const end = activity.end_date < horizonEnd ? activity.end_date : horizonEnd;
    for (const day of eachDay(start, end)) {
      if (!isWorkingDay(day, new Set())) continue;
      const key = `${activity.assignee_id}|${day}`;
      const entry = conflictDays.get(key) ?? { date: day, fte: 0, names: [] };
      const fte = activity.fte_override ?? activity.fte ?? 0.5;
      entry.fte = Math.round((entry.fte + fte) * 100) / 100;
      entry.names.push(activity.activity);
      conflictDays.set(key, entry);
    }
  }
  const conflictSeen = new Set<string>();
  for (const [key, entry] of conflictDays) {
    if (entry.fte <= 1.0001) continue;
    const personId = key.split("|")[0];
    if (conflictSeen.has(personId)) continue;
    conflictSeen.add(personId);
    issues.push({
      severity: "warning",
      entity: "person",
      entity_id: personId,
      rule: "activity.fte_conflict",
      message: `Over-allocated at ${entry.fte} FTE on ${entry.date} (${entry.names.slice(0, 3).join(", ")}).`,
    });
  }

  for (const item of scopedRows(all<any>(`SELECT * FROM recording_pipeline`))) {
    const hasPlanned = isValidRange(item.planned_start, item.planned_end);
    const hasActual = isValidRange(item.actual_start, item.actual_end);
    if (!hasPlanned && !hasActual) {
      issues.push({
        severity: "warning",
        entity: "pipeline",
        entity_id: item.id,
        rule: "pipeline.missing_dates",
        message: `${item.activity} has no valid planned or actual range.`,
      });
    }
    if (item.current_status === "Blocked" && !item.blocker) {
      issues.push({
        severity: "error",
        entity: "pipeline",
        entity_id: item.id,
        rule: "pipeline.blocked_without_reason",
        message: `${item.activity} is blocked without a reason.`,
      });
    }
    if (item.is_test) {
      issues.push({
        severity: "info",
        entity: "pipeline",
        entity_id: item.id,
        rule: "pipeline.test_record",
        message: `${item.activity} is a TEST record (demo only).`,
      });
    }
    if (item.verification_status === "Needs operational confirmation") {
      issues.push({
        severity: "info",
        entity: "pipeline",
        entity_id: item.id,
        rule: "pipeline.needs_confirmation",
        message: `${item.activity} is a TEST-labelled source record awaiting owner confirmation.`,
      });
    }
  }

  for (const train of scopedRows(all<any>(`SELECT * FROM pqu_trains`))) {
    if (train.flag) {
      issues.push({
        severity: "warning",
        entity: "pqu_train",
        entity_id: train.id,
        rule: "pqu.chronology",
        message: `${train.train}: ${train.flag}`,
      });
    }
  }

  for (const decision of scopedRows(all<any>(`SELECT * FROM release_governance`))) {
    if (decision.go_no_go === "Go" && decision.regression_status !== "Passed") {
      issues.push({
        severity: "error",
        entity: "release_governance",
        entity_id: decision.id,
        rule: "governance.go_without_regression",
        message: `${decision.version}: Go decision while regression is ${decision.regression_status}.`,
      });
    }
  }

  // Release QA windows feed the QA and FTE calendars, so their gaps are data
  // quality issues rather than cosmetic ones.
  const releaseAssignees = new Map<string, number>();
  for (const row of all<{ release_id: string; n: number }>(
    `SELECT release_id, COUNT(*) AS n FROM release_assignees GROUP BY release_id`
  )) {
    releaseAssignees.set(row.release_id, Number(row.n));
  }
  for (const release of scopedRows(all<any>(`SELECT * FROM release_feed`))) {
    const from = release.qa_start_date as string | null;
    const to = release.qa_end_date as string | null;
    if (!from && !to) {
      issues.push({
        severity: "info",
        entity: "release_feed",
        entity_id: release.id,
        rule: "release.qa_window_missing",
        message: `${release.version}: no QA window — it cannot be resourced or shown on the calendars.`,
      });
      continue;
    }
    if (!isValidRange(from, to)) {
      issues.push({
        severity: "error",
        entity: "release_feed",
        entity_id: release.id,
        rule: "release.qa_window_invalid",
        message: `${release.version}: QA window ${from ?? "?"} → ${to ?? "?"} is incomplete or reversed.`,
      });
      continue;
    }
    if (!(releaseAssignees.get(release.id) ?? 0)) {
      issues.push({
        severity: "warning",
        entity: "release_feed",
        entity_id: release.id,
        rule: "release.qa_window_unassigned",
        message: `${release.version}: QA window ${from} → ${to} has no assignees — effort is unknown, not zero.`,
      });
    }
    if (isIsoDate(release.date) && release.date < (to as string)) {
      issues.push({
        severity: "warning",
        entity: "release_feed",
        entity_id: release.id,
        rule: "release.qa_window_after_release",
        message: `${release.version}: QA window ends ${to} after the release date ${release.date}.`,
      });
    }
  }

  for (const release of scopedRows(all<any>(`SELECT * FROM release_feed WHERE link IS NOT NULL AND link <> '' AND link_verified = 0`))) {
    issues.push({
      severity: "info",
      entity: "release_feed",
      entity_id: release.id,
      rule: "release.link_unverified",
      message: `${release.version}: link not verified — it will not be auto-opened.`,
    });
  }

  for (const enh of scopedRows(all<any>(`SELECT * FROM enhancements WHERE status NOT IN ('Archived','Rejected')`))) {
    if (!enh.success_criteria) {
      issues.push({
        severity: "info",
        entity: "enhancement",
        entity_id: enh.id,
        rule: "enhancement.missing_success",
        message: `${enh.ref} ${enh.title}: no success criteria.`,
      });
    }
  }

  for (const exclusion of scopedRows(all<any>(`SELECT * FROM pipeline_exclusions`))) {
    if (!exclusion.reason) {
      issues.push({
        severity: "error",
        entity: "pipeline_exclusion",
        entity_id: exclusion.id,
        rule: "exclusion.no_reason",
        message: `Exclusion on ${exclusion.date} has no reason.`,
      });
    }
  }

  const activePeople = all<any>(`SELECT * FROM people WHERE active = 1`).filter((person) => {
    if (!companyId) return true;
    const dept = person.department_id ? departments.get(person.department_id) : null;
    return dept?.company_id === companyId;
  });
  const monthStartIso = `${today.slice(0, 7)}-01`;
  const lastDay = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)
  ).getUTCDate();
  const currentDays = eachDay(monthStartIso, `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`).filter(
    (day) => isWorkingDay(day, new Set())
  );
  const capacityKeys = new Set(
    all<any>(`SELECT person_id, date FROM resource_day_capacity WHERE date >= ? AND date <= ?`, currentDays[0], currentDays[currentDays.length - 1])
      .filter((c) => !companyId || activePeople.some((person) => person.id === c.person_id))
      .map((c) => `${c.person_id}|${c.date}`)
  );
  let missingCount = 0;
  for (const person of activePeople) {
    for (const day of currentDays) {
      if (!capacityKeys.has(`${person.id}|${day}`)) missingCount += 1;
    }
  }
  if (missingCount > 0 && activePeople.length) {
    issues.push({
      severity: "info",
      entity: "capacity",
      entity_id: null,
      rule: "capacity.missing_entry",
      message: `${missingCount} person-day capacity entries are missing this month.`,
    });
  }
  for (const entry of all<any>(`SELECT * FROM resource_day_capacity WHERE total_hours = 8`).filter((entry) =>
    !companyId || activePeople.some((person) => person.id === entry.person_id)
  )) {
    issues.push({
      severity: "info",
      entity: "capacity",
      entity_id: entry.id,
      rule: "capacity.assumed_eight_hours",
      message: `${entry.date}: total hours set to exactly 8 — source used 7.6 or 4.`,
    });
  }

  // Attribute every issue to exactly one tenant so a Data Quality badge can
  // never aggregate another company's rows. IDs are globally unique, so a map
  // from entity id -> company id is sufficient and cheap.
  const companyByEntity = new Map<string, string | null>();
  const remember = (rows: any[], entity: string) => {
    for (const row of rows) companyByEntity.set(`${entity}:${row.id}`, row.company_id ?? null);
  };
  remember(activities, "activity");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM recording_pipeline`)), "pipeline");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM pqu_trains`)), "pqu_train");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM release_governance`)), "release_governance");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM release_feed`)), "release_feed");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM enhancements`)), "enhancement");
  remember(scopedRows(all<any>(`SELECT id, company_id FROM pipeline_exclusions`)), "pipeline_exclusion");
  remember(
    all<any>(
      `SELECT r.id, d.company_id FROM resource_day_capacity r
         JOIN people p ON p.id = r.person_id
         JOIN departments d ON d.id = p.department_id`
    ),
    "capacity"
  );
  for (const person of all<any>(`SELECT id, department_id FROM people`)) {
    const dept = person.department_id ? departments.get(person.department_id) : null;
    companyByEntity.set(`person:${person.id}`, dept?.company_id ?? null);
  }
  for (const issue of issues) {
    const key = issue.entity_id ? `${issue.entity}:${issue.entity_id}` : "";
    issue.company_id = companyByEntity.get(key) ?? companyId ?? null;
  }

  return issues;
}

export function persistIssues(issues: Issue[], companyId?: string | null) {
  const seen = new Set<string>();
  for (const issue of issues) {
    seen.add(`${issue.entity}|${issue.entity_id ?? ""}|${issue.rule}`);
    const existing = get<any>(
      `SELECT id FROM validation_issues WHERE entity = ? AND entity_id IS ? AND rule = ?`,
      issue.entity,
      issue.entity_id,
      issue.rule
    );
    if (existing) {
      run(
        `UPDATE validation_issues SET severity = ?, message = ?, company_id = COALESCE(?, company_id), last_seen = datetime('now'),
          status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END WHERE id = ?`,
        issue.severity,
        issue.message,
        issue.company_id ?? null,
        existing.id
      );
    } else {
      run(
        `INSERT INTO validation_issues (id, severity, entity, entity_id, rule, message, status, company_id)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        uid("vi"),
        issue.severity,
        issue.entity,
        issue.entity_id,
        issue.rule,
        issue.message,
        issue.company_id ?? null
      );
    }
  }
  for (const row of all<any>(`SELECT id, entity, entity_id, rule, company_id FROM validation_issues WHERE status = 'open'`)) {
    if (companyId && row.company_id && row.company_id !== companyId) continue;
    if (!seen.has(`${row.entity}|${row.entity_id ?? ""}|${row.rule}`)) {
      run(`UPDATE validation_issues SET status = 'resolved', last_seen = datetime('now') WHERE id = ?`, row.id);
    }
  }
  return issues.length;
}

export function runValidation(companyId?: string | null) {
  const issues = detectIssues(companyId);
  persistIssues(issues, companyId);
  return issues;
}

export function validationSummary(companyId?: string | null) {
  const rows = all<any>(
    `SELECT severity, COUNT(*) AS n FROM validation_issues WHERE status = 'open'${companyId ? " AND company_id = ?" : ""} GROUP BY severity`,
    ...(companyId ? [companyId] : [])
  );
  const counts = { error: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const row of rows || []) counts[row.severity] = row.n;
  return counts;
}

export function daysUntil(date: string) {
  return diffDays(isoToday(), date);
}

export function checkIso(date?: string | null) {
  return !date || isIsoDate(date);
}
