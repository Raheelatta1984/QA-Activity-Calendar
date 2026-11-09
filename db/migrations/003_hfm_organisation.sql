-- ===========================================================================
-- 003_hfm_organisation.sql — HFM organisation, provenance and import schema
--
-- Additive and constraint-relaxing only. No data is deleted. Table rebuilds
-- (people, recording_pipeline) follow DROP + RENAME and rely on the migration
-- runner suspending PRAGMA foreign_keys for the duration of the migration.
-- Source provenance columns (source_dataset / external_source_id / source_order)
-- are used by the idempotent HFM seed in scripts/hfm-import.ts.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Organisation: entities live between companies and departments
-- (Company -> Entity -> Department). database-generated TEXT ids throughout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, name)
);

ALTER TABLE companies ADD COLUMN aliases TEXT;             -- JSON array of known aliases
ALTER TABLE companies ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN code TEXT;                 -- stable external key, e.g. 'HFM'

ALTER TABLE departments ADD COLUMN entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL;

-- Only one default company may exist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_default ON companies(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_code ON companies(code) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- people rebuild: email becomes nullable (Damien Milthorpe has no verified
-- email yet — it must stay NULL rather than be invented) and department-scoped
-- role assignment is supported. UNIQUE(email) still allows multiple NULLs.
-- ---------------------------------------------------------------------------
CREATE TABLE people_new (
  id                       TEXT PRIMARY KEY,
  department_id            TEXT REFERENCES departments(id) ON DELETE SET NULL,
  manager_id               TEXT REFERENCES people(id) ON DELETE SET NULL,
  name                     TEXT NOT NULL,
  email                    TEXT UNIQUE,                 -- NULL until verified; never invented
  title                    TEXT,
  role                     TEXT NOT NULL DEFAULT 'viewer', -- viewer|editor|manager|department_admin|exec|admin (application admin)
  role_scope_department_id TEXT REFERENCES departments(id) ON DELETE SET NULL, -- set for department_admin only
  password_hash            TEXT,
  capacity_hours_day       REAL NOT NULL DEFAULT 7.6,
  colour                   TEXT NOT NULL DEFAULT '#8b9dc3',
  active                   INTEGER NOT NULL DEFAULT 1,
  is_demo                  INTEGER NOT NULL DEFAULT 0,
  external_source_id       TEXT,
  source_dataset           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO people_new (
  id, department_id, manager_id, name, email, title, role, role_scope_department_id,
  password_hash, capacity_hours_day, colour, active, is_demo, external_source_id, source_dataset, created_at
)
SELECT
  id, department_id, manager_id, name, email, title, role, NULL,
  password_hash, capacity_hours_day, colour, active, is_demo, NULL, NULL, created_at
FROM people;
DROP TABLE people;
ALTER TABLE people_new RENAME TO people;
CREATE INDEX IF NOT EXISTS ix_people_manager ON people(manager_id);
CREATE INDEX IF NOT EXISTS ix_people_department ON people(department_id);
CREATE INDEX IF NOT EXISTS ix_people_role_scope ON people(role_scope_department_id);

-- ---------------------------------------------------------------------------
-- activities: additive provenance/scheduling columns. status stays NOT NULL
-- with the app's safe default ('Draft' is written for blank source statuses;
-- the raw value is preserved in source_status_raw). duration_days keeps the
-- legacy end-minus-start+1 meaning; source/effective values are separate.
-- ---------------------------------------------------------------------------
ALTER TABLE activities ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN source_dataset TEXT;
ALTER TABLE activities ADD COLUMN external_source_id TEXT;   -- immutable source Calendar Item ID (literal string)
ALTER TABLE activities ADD COLUMN source_order INTEGER;
ALTER TABLE activities ADD COLUMN source_duration_days INTEGER;
ALTER TABLE activities ADD COLUMN effective_duration_days INTEGER; -- inclusive calendar days, only when both dates valid
ALTER TABLE activities ADD COLUMN source_assignee_text TEXT; -- raw "Assing To" label, e.g. 'Sudeep/Mukti'
ALTER TABLE activities ADD COLUMN colour_label TEXT;         -- raw source Colour label, e.g. 'Lime'
ALTER TABLE activities ADD COLUMN source_active_status TEXT; -- raw Active Status label
ALTER TABLE activities ADD COLUMN source_status_raw TEXT;    -- raw Status value; NULL preserved
ALTER TABLE activities ADD COLUMN source_data_quality TEXT;  -- raw Data Quality value (kept alongside data_quality for parity)
CREATE UNIQUE INDEX IF NOT EXISTS ux_activities_source
  ON activities(company_id, source_dataset, external_source_id);
CREATE INDEX IF NOT EXISTS ix_activities_company ON activities(company_id);

-- ---------------------------------------------------------------------------
-- recording_pipeline rebuild: Recording Status, Current Status and Automation %
-- become genuinely nullable (blanks are preserved, never zero-filled), and the
-- full source provenance/quality payload is retained.
-- ---------------------------------------------------------------------------
CREATE TABLE recording_pipeline_new (
  id                            TEXT PRIMARY KEY,
  code                          TEXT,
  department_id                 TEXT REFERENCES departments(id) ON DELETE SET NULL,
  company_id                    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  activity                      TEXT NOT NULL,
  detail                        TEXT,
  activity_group                TEXT,
  applications_raw              TEXT,                    -- raw "Application(s)" text
  planned_start                 TEXT,
  planned_end                   TEXT,
  actual_start                  TEXT,
  actual_end                    TEXT,
  duration_days                 INTEGER,                 -- legacy slot (never the source snapshot)
  source_duration_days          INTEGER,                 -- raw source "Duration Days" snapshot
  effective_duration_days       INTEGER,                 -- live Mon–Fri duration (provisional); see lib/pipeline.ts
  recording_status              TEXT,                    -- raw Recording Status (NULL preserved)
  current_status                TEXT,                    -- raw Current Status (NULL preserved)
  automation_percent            INTEGER,                 -- derived display integer (NULL preserved)
  automation_fraction           REAL,                    -- canonical fraction 0..1 (NULL = unknown)
  blocker                       TEXT,                    -- raw Current Blockers
  colour                        TEXT NOT NULL DEFAULT '#a855f7',
  colour_label                  TEXT,                    -- raw source Colour label
  assignee_id                   TEXT REFERENCES people(id) ON DELETE SET NULL,
  is_test                       INTEGER NOT NULL DEFAULT 0,
  source_test_label             INTEGER NOT NULL DEFAULT 0,
  verification_status           TEXT,                    -- 'Needs operational confirmation' until owner confirms
  notes                         TEXT,
  data_quality_warning          TEXT,                    -- raw Data Quality Warning snapshot
  overlap_warning               TEXT,                    -- raw Overlap Warning snapshot
  excluded_priority_work_dates  TEXT,                    -- raw source snapshot, NOT parsed into manual exclusions
  source_sheet                  TEXT,
  source_row                    INTEGER,
  source_order                  INTEGER,
  source_dataset                TEXT,
  external_source_id            TEXT,                    -- immutable Pipeline ID (literal string)
  import_batch_id               TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO recording_pipeline_new (
  id, code, department_id, company_id, activity, detail, activity_group, applications_raw,
  planned_start, planned_end, actual_start, actual_end, duration_days, source_duration_days,
  recording_status, current_status, automation_percent, automation_fraction, blocker,
  colour, colour_label, assignee_id, is_test, source_test_label, verification_status, notes,
  data_quality_warning, overlap_warning, excluded_priority_work_dates,
  source_sheet, source_row, source_order, source_dataset, external_source_id, import_batch_id, created_at
)
SELECT
  id, code, department_id, NULL, activity, detail, NULL, NULL,
  planned_start, planned_end, actual_start, actual_end, duration_days, NULL,
  recording_status, current_status, automation_percent,
  CASE WHEN automation_percent IS NULL THEN NULL ELSE automation_percent / 100.0 END,
  blocker,
  colour, NULL, assignee_id, is_test, COALESCE(is_test, 0), NULL, notes,
  NULL, NULL, NULL,
  source_sheet, source_row, NULL, NULL, NULL, import_batch_id, created_at
FROM recording_pipeline;
DROP TABLE recording_pipeline;
ALTER TABLE recording_pipeline_new RENAME TO recording_pipeline;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pipeline_source
  ON recording_pipeline(company_id, source_dataset, external_source_id);
CREATE INDEX IF NOT EXISTS ix_pipeline_dept ON recording_pipeline(department_id);
CREATE INDEX IF NOT EXISTS ix_pipeline_company ON recording_pipeline(company_id);

-- ---------------------------------------------------------------------------
-- pipeline_exclusions: provenance + warning capture. NULL pipeline_id stays
-- valid (global exclusion). Manual exclusions are deduplicated per pipeline+date
-- now; existing duplicates (if any) are collapsed keeping the earliest row.
-- ---------------------------------------------------------------------------
ALTER TABLE pipeline_exclusions ADD COLUMN source_dataset TEXT;
ALTER TABLE pipeline_exclusions ADD COLUMN source_row INTEGER;
ALTER TABLE pipeline_exclusions ADD COLUMN exclusion_warning TEXT;
ALTER TABLE pipeline_exclusions ADD COLUMN import_batch_id TEXT;
DELETE FROM pipeline_exclusions
 WHERE pipeline_id IS NOT NULL AND id NOT IN (
   SELECT MIN(id) FROM pipeline_exclusions GROUP BY pipeline_id, date
 );
CREATE UNIQUE INDEX IF NOT EXISTS ux_exclusions_pipeline_date
  ON pipeline_exclusions(pipeline_id, date);

-- ---------------------------------------------------------------------------
-- import_batches: record who requested and who executed (service migrations
-- must name the real executor; requested_by stays Raheel per the work order).
-- ---------------------------------------------------------------------------
ALTER TABLE import_batches ADD COLUMN requested_by TEXT;
ALTER TABLE import_batches ADD COLUMN executor TEXT;
ALTER TABLE import_batches ADD COLUMN report_path TEXT;
