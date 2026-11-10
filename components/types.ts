export type ClientActivity = {
  id: string;
  code: string | null;
  activity: string;
  detail: string | null;
  group: string;
  colour: string;
  assignee_id: string | null;
  assignee_name: string;
  department_id: string | null;
  department_name: string;
  status: string;
  priority: string;
  start_date: string | null;
  end_date: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  fte: number;
  duration_days: number | null;
  progress: number;
  notes: string | null;
  data_quality: string | null;
  active: number;
  rule_type: string | null;
  source_sheet: string | null;
  source_row: number | null;
  bug_reported: number;
  bug_fixed: number;
  bug_closed: number;
  bug_outstanding: number;
  scheduled: boolean;
};

export type ClientPipeline = {
  id: string;
  code: string | null;
  activity: string;
  detail: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  effective_start: string | null;
  effective_end: string | null;
  recording_status: string | null;
  current_status: string | null;
  automation_percent: number | null;
  verification_status: string | null;
  effective_duration_days: number | null;
  weekdays_in_range: number;
  blocked_auto_days: string[];
  blocked_manual_days: string[];
  duration_provisional: boolean;
  source_duration_days: number | null;
  activity_group: string | null;
  applications_raw: string | null;
  colour_label: string | null;
  blocker: string | null;
  colour: string;
  assignee_name: string;
  is_test: number;
  eligible_days: number;
  blocked_days: string[];
  warnings: string[];
  notes: string | null;
};

export type ClientPerson = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  colour: string;
  department_id: string | null;
  department_name?: string;
  manager_id: string | null;
};

export type ClientDepartment = { id: string; name: string; colour: string; enabled: number };

export type DayMeta = {
  date: string;
  day: number;
  inMonth: boolean;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isToday: boolean;
  isCurrentWeek: boolean;
};

export type ClientReleaseBar = {
  release_id: string;
  version: string;
  kind: string;
  start_date: string;
  end_date: string;
  colour: string;
  status: string;
  assignee_names: string;
  assignee_ids: string[];
  fte_per_day: number;
  working_days: number;
  fte_days: number;
};
