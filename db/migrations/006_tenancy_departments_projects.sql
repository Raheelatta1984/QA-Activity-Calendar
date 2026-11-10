-- ===========================================================================
-- 006_tenancy_departments_projects.sql — tenant isolation, linked identities,
-- injected tenant copies and the activity project name.
--
-- Additive and non-destructive only: every statement adds a column, a table or
-- an index, or back-fills a newly added column from data that already exists.
-- No row is deleted and no existing column is rewritten.
--
-- Tenant rules
--   * `company_id` is the tenant key. Activities and recording_pipeline already
--     had one; every other operational table that could leak across companies
--     gains one here.
--   * `department_id` is the department key inside a tenant.
--   * `project_name` is optional: legacy rows stay NULL and render as "—",
--     never as an invented project.
--   * Injected copies are identified by `copy_batch_id` + `copied_from_id`.
--     The source row keeps its own id and is never touched, so deleting a batch
--     can only remove copies.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Activity project name + injection provenance
-- ---------------------------------------------------------------------------
ALTER TABLE activities ADD COLUMN project_name TEXT;
ALTER TABLE activities ADD COLUMN copy_batch_id TEXT;
ALTER TABLE activities ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_activities_project ON activities(project_name);
CREATE INDEX IF NOT EXISTS ix_activities_copy_batch ON activities(copy_batch_id);

-- ---------------------------------------------------------------------------
-- People: linked identity for a person who belongs to more than one tenant.
-- The linked row keeps email and password_hash NULL; the original HFM account
-- remains the sole credential holder. Never invent an email or a login.
-- ---------------------------------------------------------------------------
ALTER TABLE people ADD COLUMN linked_person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_people_linked ON people(linked_person_id);

-- ---------------------------------------------------------------------------
-- Recording pipeline injection provenance
-- ---------------------------------------------------------------------------
ALTER TABLE recording_pipeline ADD COLUMN copy_batch_id TEXT;
ALTER TABLE recording_pipeline ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_pipeline_copy_batch ON recording_pipeline(copy_batch_id);

-- ---------------------------------------------------------------------------
-- Releases: tenant ownership for the feed, governance and PQU trains
-- ---------------------------------------------------------------------------
ALTER TABLE release_feed ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE release_feed ADD COLUMN copy_batch_id TEXT;
ALTER TABLE release_feed ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_release_feed_company ON release_feed(company_id);
CREATE INDEX IF NOT EXISTS ix_release_feed_copy_batch ON release_feed(copy_batch_id);

ALTER TABLE release_governance ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE release_governance ADD COLUMN department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE release_governance ADD COLUMN copy_batch_id TEXT;
ALTER TABLE release_governance ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_release_governance_company ON release_governance(company_id);
CREATE INDEX IF NOT EXISTS ix_release_governance_copy_batch ON release_governance(copy_batch_id);

ALTER TABLE pqu_trains ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE pqu_trains ADD COLUMN copy_batch_id TEXT;
ALTER TABLE pqu_trains ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_pqu_company ON pqu_trains(company_id);
CREATE INDEX IF NOT EXISTS ix_pqu_copy_batch ON pqu_trains(copy_batch_id);

-- ---------------------------------------------------------------------------
-- Defects / services: tenant ownership
-- ---------------------------------------------------------------------------
ALTER TABLE bugs ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE bugs ADD COLUMN department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE bugs ADD COLUMN copy_batch_id TEXT;
ALTER TABLE bugs ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_bugs_company ON bugs(company_id);
CREATE INDEX IF NOT EXISTS ix_bugs_copy_batch ON bugs(copy_batch_id);

ALTER TABLE applications ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE applications ADD COLUMN copy_batch_id TEXT;
ALTER TABLE applications ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_applications_company ON applications(company_id);

ALTER TABLE backend_services ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE backend_services ADD COLUMN copy_batch_id TEXT;
ALTER TABLE backend_services ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_backend_services_company ON backend_services(company_id);

ALTER TABLE service_deployment_plans ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE service_deployment_plans ADD COLUMN copy_batch_id TEXT;
ALTER TABLE service_deployment_plans ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_deployment_plans_company ON service_deployment_plans(company_id);

-- ---------------------------------------------------------------------------
-- Pipeline exclusions, capacity, enhancements, imports and validation:
-- tenant keys so a switcher, report or background check cannot see another
-- company's rows.
-- ---------------------------------------------------------------------------
ALTER TABLE pipeline_exclusions ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE pipeline_exclusions ADD COLUMN copy_batch_id TEXT;
ALTER TABLE pipeline_exclusions ADD COLUMN copied_from_id TEXT;
CREATE INDEX IF NOT EXISTS ix_exclusions_company ON pipeline_exclusions(company_id);

ALTER TABLE resource_day_capacity ADD COLUMN copy_batch_id TEXT;
CREATE INDEX IF NOT EXISTS ix_capacity_copy_batch ON resource_day_capacity(copy_batch_id);

ALTER TABLE enhancements ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_enhancements_company ON enhancements(company_id);

ALTER TABLE import_batches ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE import_batches ADD COLUMN department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_import_batches_company ON import_batches(company_id);

ALTER TABLE validation_issues ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_validation_issues_company ON validation_issues(company_id);

ALTER TABLE original_notes_archive ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE audit_events ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_audit_company ON audit_events(company_id);

-- ---------------------------------------------------------------------------
-- Injection batches: one active batch per source→target pair. A completed
-- deletion marks the batch 'deleted', which allows a later safe re-injection
-- without touching anything else. Copy rows reference the batch id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_injections (
  id                TEXT PRIMARY KEY,
  source_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label             TEXT,
  status            TEXT NOT NULL DEFAULT 'active', -- active|deleted
  counts_json       TEXT,
  created_by        TEXT REFERENCES people(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by        TEXT REFERENCES people(id) ON DELETE SET NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_injections_active
  ON tenant_injections(source_company_id, target_company_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Back-fill tenant keys for existing production rows. Migration-owned data is
-- never deleted; a row whose department has no company falls back to the
-- configured default company (or the oldest company) so it remains visible in
-- exactly one tenant instead of leaking into all of them.
-- ---------------------------------------------------------------------------
UPDATE activities SET company_id = (
  SELECT d.company_id FROM departments d WHERE d.id = activities.department_id
) WHERE company_id IS NULL AND department_id IS NOT NULL;
UPDATE activities SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE recording_pipeline SET company_id = (
  SELECT d.company_id FROM departments d WHERE d.id = recording_pipeline.department_id
) WHERE company_id IS NULL AND department_id IS NOT NULL;
UPDATE recording_pipeline SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE release_feed SET company_id = (
  SELECT d.company_id FROM departments d WHERE d.id = release_feed.department_id
) WHERE company_id IS NULL AND department_id IS NOT NULL;
UPDATE release_feed SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE release_governance SET company_id = (
  SELECT r.company_id FROM release_feed r WHERE r.id = release_governance.release_id
) WHERE company_id IS NULL;
UPDATE release_governance SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE pqu_trains SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE bugs SET company_id = (
  SELECT a.company_id FROM activities a WHERE a.id = bugs.activity_id
) WHERE company_id IS NULL AND activity_id IS NOT NULL;
UPDATE bugs SET department_id = (
  SELECT a.department_id FROM activities a WHERE a.id = bugs.activity_id
) WHERE department_id IS NULL AND activity_id IS NOT NULL;
UPDATE bugs SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE applications SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE backend_services SET company_id = (
  SELECT a.company_id FROM applications a WHERE a.id = backend_services.application_id
) WHERE company_id IS NULL AND application_id IS NOT NULL;
UPDATE backend_services SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE service_deployment_plans SET company_id = (
  SELECT a.company_id FROM applications a WHERE a.id = service_deployment_plans.application_id
) WHERE company_id IS NULL AND application_id IS NOT NULL;
UPDATE service_deployment_plans SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE pipeline_exclusions SET company_id = (
  SELECT p.company_id FROM recording_pipeline p WHERE p.id = pipeline_exclusions.pipeline_id
) WHERE company_id IS NULL AND pipeline_id IS NOT NULL;
UPDATE pipeline_exclusions SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE enhancements SET company_id = (
  SELECT d.company_id FROM departments d WHERE d.id = enhancements.department_id
) WHERE company_id IS NULL AND department_id IS NOT NULL;
UPDATE enhancements SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE import_batches SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE validation_issues SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;

UPDATE original_notes_archive SET company_id = (
  SELECT c.id FROM companies c ORDER BY c.is_default DESC, c.created_at, c.id LIMIT 1
) WHERE company_id IS NULL;
