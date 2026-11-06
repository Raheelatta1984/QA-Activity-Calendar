-- ===========================================================================
-- 001_init.sql — HFM QA Activity Calendar core schema
-- Portable SQLite (dev/test). Postgres DDL notes live in docs/ERD.md.
-- Every imported row keeps provenance (source_sheet, source_row, import_batch_id).
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Organisation / master setup
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  legal_name          TEXT,
  timezone            TEXT NOT NULL DEFAULT 'Australia/Sydney',
  fiscal_start_month  INTEGER NOT NULL DEFAULT 7,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  colour      TEXT NOT NULL DEFAULT '#4f8cff',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_departments_code ON departments(company_id, code);

CREATE TABLE IF NOT EXISTS people (
  id                  TEXT PRIMARY KEY,
  department_id       TEXT REFERENCES departments(id) ON DELETE SET NULL,
  manager_id          TEXT REFERENCES people(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  title               TEXT,
  role                TEXT NOT NULL DEFAULT 'viewer', -- admin|exec|manager|editor|viewer
  password_hash       TEXT,
  capacity_hours_day  REAL NOT NULL DEFAULT 7.6,
  colour              TEXT NOT NULL DEFAULT '#8b9dc3',
  active              INTEGER NOT NULL DEFAULT 1,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_people_manager ON people(manager_id);
CREATE INDEX IF NOT EXISTS ix_people_department ON people(department_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  impersonate_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Reference configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,             -- date-only YYYY-MM-DD
  name         TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'NSW',
  year         INTEGER NOT NULL,
  source       TEXT,
  UNIQUE(date, jurisdiction)
);

CREATE TABLE IF NOT EXISTS colour_rules (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  hex       TEXT NOT NULL,
  meaning   TEXT,
  applies_to TEXT DEFAULT 'activity',
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Activities (Master Activity Data / tblActivities)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id                TEXT PRIMARY KEY,
  code              TEXT,                        -- source Calendar Item ID / stable public ref
  department_id     TEXT REFERENCES departments(id) ON DELETE SET NULL,
  activity          TEXT NOT NULL,
  detail            TEXT,
  activity_group    TEXT NOT NULL DEFAULT 'QA',
  rule_type         TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  start_date        TEXT,                        -- inclusive planned schedule (legacy start/end)
  end_date          TEXT,
  duration_days     INTEGER,                     -- end-start+1 calendar days (source parity)
  fte               REAL NOT NULL DEFAULT 0.5,
  fte_override      REAL,
  colour            TEXT NOT NULL DEFAULT '#4f8cff',
  assignee_id       TEXT REFERENCES people(id) ON DELETE SET NULL, -- NULL = Unassigned
  status            TEXT NOT NULL DEFAULT 'Planned',
  notes             TEXT,
  data_quality      TEXT,
  calendar_item_id  TEXT,
  planned_start     TEXT,
  planned_end       TEXT,
  actual_start      TEXT,
  actual_end        TEXT,
  progress_percent  INTEGER NOT NULL DEFAULT 0,
  priority          TEXT NOT NULL DEFAULT 'Normal',
  is_demo           INTEGER NOT NULL DEFAULT 0,
  source_sheet      TEXT,
  source_row        INTEGER,
  import_batch_id   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fte >= 0 AND fte <= 5)
);
CREATE INDEX IF NOT EXISTS ix_activities_dates ON activities(start_date, end_date);
CREATE INDEX IF NOT EXISTS ix_activities_assignee ON activities(assignee_id);
CREATE INDEX IF NOT EXISTS ix_activities_dept ON activities(department_id);

CREATE TABLE IF NOT EXISTS activity_assignments (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  share       REAL NOT NULL DEFAULT 1.0,  -- allocation share (0..1) across assignees
  UNIQUE(activity_id, person_id)
);

CREATE TABLE IF NOT EXISTS effort_overrides (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  person_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
  date        TEXT NOT NULL,
  fte         REAL,
  hours       REAL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Recording pipeline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recording_pipeline (
  id                 TEXT PRIMARY KEY,
  code               TEXT,
  department_id      TEXT REFERENCES departments(id) ON DELETE SET NULL,
  activity           TEXT NOT NULL,
  detail             TEXT,
  planned_start      TEXT,
  planned_end        TEXT,
  actual_start       TEXT,
  actual_end         TEXT,
  duration_days      INTEGER,
  recording_status   TEXT NOT NULL DEFAULT 'Not started',
  current_status     TEXT NOT NULL DEFAULT 'Pending',
  automation_percent INTEGER NOT NULL DEFAULT 0,
  blocker            TEXT,
  colour             TEXT NOT NULL DEFAULT '#a855f7',
  assignee_id        TEXT REFERENCES people(id) ON DELETE SET NULL,
  is_test            INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  source_sheet       TEXT,
  source_row         INTEGER,
  import_batch_id    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_exclusions (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT REFERENCES recording_pipeline(id) ON DELETE CASCADE, -- NULL = all pipeline
  date        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_exclusions_date ON pipeline_exclusions(date);

-- ---------------------------------------------------------------------------
-- Releases: feed, PQU schedule, governance, deployment plans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS release_feed (
  id            TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'Self Update', -- Self Update|Auto Update|Manual
  date          TEXT,
  notes         TEXT,
  link          TEXT,
  link_verified INTEGER NOT NULL DEFAULT 0,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pqu_trains (
  id               TEXT PRIMARY KEY,
  train            TEXT NOT NULL,
  change_cutoff    TEXT,
  duration_days    INTEGER,
  status           TEXT NOT NULL DEFAULT 'Planned',
  app_version      TEXT,
  platform_version TEXT,
  date_text_raw    TEXT,
  flag             TEXT,   -- chronology / parsing suspicion surfaced to the user
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS release_governance (
  id                TEXT PRIMARY KEY,
  release_id        TEXT NOT NULL,
  version           TEXT,
  regression_status TEXT NOT NULL DEFAULT 'Not started',
  go_no_go          TEXT NOT NULL DEFAULT 'Pending',
  deployment_status TEXT NOT NULL DEFAULT 'Not deployed',
  decided_by        TEXT REFERENCES people(id) ON DELETE SET NULL,
  decided_at        TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT,
  owner       TEXT,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS backend_services (
  id             TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS service_deployment_plans (
  id             TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
  service        TEXT,
  start_date     TEXT,
  weeks          INTEGER,
  planned_date   TEXT,
  actual_date    TEXT,
  manual_override_date TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Capacity (Resource day capacity & effort)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_day_capacity (
  id                 TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date               TEXT NOT NULL,
  not_available_hours REAL NOT NULL DEFAULT 0,
  devops_hours       REAL NOT NULL DEFAULT 0,
  recording_hours    REAL NOT NULL DEFAULT 0,
  qa_testing_hours   REAL NOT NULL DEFAULT 0,
  total_hours        REAL NOT NULL DEFAULT 7.6,
  note               TEXT,
  source             TEXT,
  UNIQUE(person_id, date)
);
CREATE INDEX IF NOT EXISTS ix_capacity_date ON resource_day_capacity(date);

-- ---------------------------------------------------------------------------
-- Bugs / centralised reporting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bugs (
  id            TEXT PRIMARY KEY,
  bug_key       TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'Medium',
  status        TEXT NOT NULL DEFAULT 'Open', -- Open|Fixed|Closed
  reported_date TEXT,
  resolved_date TEXT,
  reported_by   TEXT REFERENCES people(id) ON DELETE SET NULL,
  activity_id   TEXT REFERENCES activities(id) ON DELETE SET NULL,
  notes         TEXT,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bug_service_links (
  id         TEXT PRIMARY KEY,
  bug_id     TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES backend_services(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'Open', -- per-service link status
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bug_id, service_id)
);

CREATE TABLE IF NOT EXISTS bug_relations (
  id          TEXT PRIMARY KEY,
  bug_id      TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  related_id  TEXT NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'duplicate'
);

CREATE TABLE IF NOT EXISTS progress_snapshots (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  as_of       TEXT NOT NULL,
  reported    INTEGER NOT NULL DEFAULT 0,
  fixed       INTEGER NOT NULL DEFAULT 0,
  closed      INTEGER NOT NULL DEFAULT 0,
  outstanding INTEGER NOT NULL DEFAULT 0,
  progress_percent INTEGER,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_progress_activity ON progress_snapshots(activity_id, as_of);

-- ---------------------------------------------------------------------------
-- App configuration: tabs, sections, sticky notes, changelog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tabs (
  id          TEXT PRIMARY KEY,     -- stable reference, e.g. tab.calendar
  key         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT 'grid',
  href        TEXT NOT NULL,
  description TEXT,
  group_name  TEXT NOT NULL DEFAULT 'Workspace',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  department_scope TEXT,           -- NULL = global tabs only
  is_system   INTEGER NOT NULL DEFAULT 1,
  min_role    TEXT NOT NULL DEFAULT 'viewer'
);

CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,     -- stable reference, e.g. sec.calendar.grid
  tab_id      TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS ix_sections_tab ON sections(tab_id);

CREATE TABLE IF NOT EXISTS sticky_notes (
  id           TEXT PRIMARY KEY,
  tab_id       TEXT REFERENCES tabs(id) ON DELETE CASCADE,
  section_id   TEXT,                -- NULL = tab-level note
  title        TEXT NOT NULL DEFAULT 'AI guidance',
  content      TEXT NOT NULL,
  colour       TEXT NOT NULL DEFAULT '#fef3c7',
  author_id    TEXT REFERENCES people(id) ON DELETE SET NULL,
  ai_generated INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS changelog (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  title      TEXT NOT NULL,
  date       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'feature', -- feature|fix|merge|pr|security
  pr_number  INTEGER,
  pr_url     TEXT,
  summary    TEXT,
  items      TEXT NOT NULL DEFAULT '[]', -- JSON array of {label, detail}
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_changelog_date ON changelog(date DESC);

CREATE TABLE IF NOT EXISTS ai_summaries (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,       -- tab id or 'dashboard'
  summary    TEXT NOT NULL,
  payload    TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider   TEXT NOT NULL DEFAULT 'local'
);

-- ---------------------------------------------------------------------------
-- Future enhancements vault
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enhancements (
  id               TEXT PRIMARY KEY,
  ref              TEXT NOT NULL UNIQUE,   -- ENH-0001
  title            TEXT NOT NULL,
  brief            TEXT,
  requirements     TEXT,
  impacts          TEXT,
  expected_outcome TEXT,
  success_criteria TEXT,
  markdown         TEXT,
  status           TEXT NOT NULL DEFAULT 'Submitted', -- Submitted|Reviewing|Accepted|Building|Built|Archived|Rejected
  github_path      TEXT,
  submitted_by     TEXT REFERENCES people(id) ON DELETE SET NULL,
  department_id    TEXT REFERENCES departments(id) ON DELETE SET NULL,
  ai_title         TEXT,
  ai_model         TEXT,
  votes            INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_enhancements_status ON enhancements(status);

-- ---------------------------------------------------------------------------
-- Data quality, provenance, imports, audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS validation_issues (
  id         TEXT PRIMARY KEY,
  severity   TEXT NOT NULL DEFAULT 'warning', -- error|warning|info
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  rule       TEXT NOT NULL,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',    -- open|acknowledged|resolved
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity, entity_id, rule)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id          TEXT PRIMARY KEY,
  filename    TEXT,
  mode        TEXT NOT NULL DEFAULT 'dry-run', -- dry-run|apply
  source_system TEXT,
  rows_total  INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'running',
  report_json TEXT,
  created_by  TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  sheet        TEXT,
  row_number   INTEGER,
  raw_json     TEXT,
  target_table TEXT,
  target_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|inserted|updated|skipped|error|conflict
  message      TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_rows_batch ON import_rows(batch_id);

CREATE TABLE IF NOT EXISTS original_notes_archive (
  id          TEXT PRIMARY KEY,
  source_sheet TEXT,
  source_row  INTEGER,
  entity_type TEXT,
  entity_id   TEXT,
  raw_text    TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  note        TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
  actor_name TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  before_json TEXT,
  after_json TEXT,
  meta       TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_events(at DESC);
