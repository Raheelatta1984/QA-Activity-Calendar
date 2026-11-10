import type { ActivityView } from "./activities";
import type { PipelineView } from "./pipeline";
import type { ClientActivity, ClientPipeline, ClientReleaseBar } from "@/components/types";
import type { ReleaseBar } from "./releases";

export function toClientActivity(a: ActivityView): ClientActivity {
  return {
    id: a.id,
    code: a.code,
    activity: a.activity,
    detail: a.detail,
    group: a.activity_group,
    colour: a.colour,
    assignee_id: a.assignee_id,
    assignee_name: a.assignee_name,
    department_id: a.department_id,
    department_name: a.department_name,
    status: a.status,
    priority: String(a.priority ?? "Normal"),
    start_date: a.start_date,
    end_date: a.end_date,
    planned_start: a.planned_start,
    planned_end: a.planned_end,
    actual_start: a.actual_start,
    actual_end: a.actual_end,
    fte: a.effective_fte,
    duration_days: a.duration_days,
    progress: a.derived_progress,
    notes: a.notes,
    data_quality: a.data_quality,
    active: a.active,
    rule_type: a.rule_type,
    source_sheet: a.source_sheet,
    source_row: a.source_row,
    bug_reported: a.bug_counts.reported,
    bug_fixed: a.bug_counts.fixed,
    bug_closed: a.bug_counts.closed,
    bug_outstanding: a.bug_counts.outstanding,
    scheduled: a.scheduled,
  };
}

export function toClientPipeline(p: PipelineView): ClientPipeline {
  return {
    id: p.id,
    code: p.code,
    activity: p.activity,
    detail: p.detail,
    planned_start: p.planned_start,
    planned_end: p.planned_end,
    actual_start: p.actual_start,
    actual_end: p.actual_end,
    effective_start: p.effective_start,
    effective_end: p.effective_end,
    recording_status: p.recording_status,
    current_status: p.current_status,
    automation_percent: p.automation_percent,
    verification_status: p.verification_status,
    effective_duration_days: p.effective_duration_days,
    weekdays_in_range: p.weekdays_in_range,
    blocked_auto_days: p.blocked_auto_days,
    blocked_manual_days: p.blocked_manual_days,
    duration_provisional: p.duration_provisional,
    source_duration_days: p.source_duration_days,
    activity_group: p.activity_group,
    applications_raw: p.applications_raw,
    colour_label: p.colour_label,
    blocker: p.blocker,
    colour: p.colour,
    assignee_name: p.assignee_name,
    is_test: p.is_test,
    eligible_days: p.eligible_days,
    blocked_days: p.blocked_days,
    warnings: p.warnings,
    notes: p.notes,
  };
}

/** Release QA window as a calendar bar (synthetic — never editable as an activity). */
export function toClientReleaseBar(bar: ReleaseBar): ClientReleaseBar {
  return {
    release_id: bar.release_id,
    version: bar.version,
    kind: bar.kind,
    start_date: bar.start_date,
    end_date: bar.end_date,
    colour: bar.colour,
    status: bar.status,
    assignee_names: bar.assignee_names,
    assignee_ids: bar.assignee_ids,
    fte_per_day: bar.fte_per_day,
    working_days: bar.working_days,
    fte_days: bar.fte_days,
  };
}
