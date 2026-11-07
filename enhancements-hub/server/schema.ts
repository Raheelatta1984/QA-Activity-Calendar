/**
 * Enhancements Hub — database schema.
 *
 * Embedded as a TypeScript constant (not a loose .sql file) so the module keeps
 * working when it is copied or bundled into a host application where non-TS
 * assets may not be traced. Run idempotently on every boot.
 *
 * Model:
 *   tenant        an organisation workspace (isolated set of applications)
 *   application   a project/product connected to a GitHub repository
 *   enhancement   a feature request, scoped to tenant + application, with the
 *                 full QA-Calendar lifecycle (Submitted → … → Archived)
 *   audit_event   every write, with actor and before/after
 *
 * Deliberately absent: people/departments tables from the source app. The hub
 * stores the actor name supplied by the host auth adapter instead, so nothing
 * about identity is imposed on the host.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  github_repo   TEXT,              -- owner/name — empty means "local vault only"
  github_branch TEXT NOT NULL DEFAULT 'main',
  handover_dir  TEXT NOT NULL DEFAULT 'future-enhancements',
  token_env     TEXT,              -- NAME of the env var holding the GitHub token
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_applications_tenant ON applications(tenant_id);

CREATE TABLE IF NOT EXISTS enhancements (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id   TEXT REFERENCES applications(id) ON DELETE SET NULL,
  ref              TEXT NOT NULL,              -- ENH-0001, unique per application
  title            TEXT NOT NULL,
  brief            TEXT NOT NULL,
  requirements     TEXT,
  impacts          TEXT,
  expected_outcome TEXT,
  success_criteria TEXT,
  sections         TEXT,                       -- impacted tab / section ids (free text)
  markdown         TEXT,                       -- raw markdown body if the author overrides rendering
  status           TEXT NOT NULL DEFAULT 'Submitted',
  github_path      TEXT,                       -- vault-relative path of the handover file
  submitted_by     TEXT,                       -- actor name from the auth adapter
  ai_fields        TEXT,                       -- JSON array: fields accepted from the drafting engine
  votes            INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (application_id, ref)
);
CREATE INDEX IF NOT EXISTS ix_enhancements_status ON enhancements(status);
CREATE INDEX IF NOT EXISTS ix_enhancements_tenant ON enhancements(tenant_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  before_json TEXT,
  after_json  TEXT,
  meta       TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_events(at);
`;

/** SQL applied to databases created before a given hub version. */
export const UPGRADES: { version: string; sql: string }[] = [
  // v1.0.0 — initial release; nothing to upgrade yet. Append entries, never
  // rewrite SCHEMA_SQL in place, so existing databases keep migrating forward.
];
