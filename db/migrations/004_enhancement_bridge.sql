-- ---------------------------------------------------------------------------
-- Two-way GitHub bridge for Future Enhancements (v2)
--
-- The bridge lets the same enhancement live in two places at once:
--   * the in-app vault (`tab.enhancements`), and
--   * an issue in *any* configured GitHub repository (not just this one).
--
-- Status, title and body travel in both directions, so work can start from
-- either end. These columns record the remote identity of a proposal and the
-- last successful synchronisation; the configuration itself lives in `settings`
-- so a deployment can be pointed at a different repository without a rebuild.
-- ---------------------------------------------------------------------------

ALTER TABLE enhancements ADD COLUMN source TEXT NOT NULL DEFAULT 'app'; -- app|github
ALTER TABLE enhancements ADD COLUMN github_repo TEXT;                  -- owner/name the issue lives in
ALTER TABLE enhancements ADD COLUMN github_issue_number INTEGER;
ALTER TABLE enhancements ADD COLUMN github_issue_url TEXT;
ALTER TABLE enhancements ADD COLUMN github_state TEXT;                 -- open|closed as last seen upstream
ALTER TABLE enhancements ADD COLUMN github_labels TEXT;                -- JSON array of remote label names
ALTER TABLE enhancements ADD COLUMN github_updated_at TEXT;            -- remote `updated_at`, for conflict detection
ALTER TABLE enhancements ADD COLUMN github_synced_at TEXT;             -- last successful push or pull
ALTER TABLE enhancements ADD COLUMN github_direction TEXT;             -- push|pull: which side won the last sync

CREATE INDEX IF NOT EXISTS ix_enhancements_issue ON enhancements(github_repo, github_issue_number);

-- Every remote object a proposal is linked to: its issue, the implementation
-- pull request(s), and any related discussion. A link is a pointer, never a
-- copy, so the remote state is re-read on every sync rather than trusted.
CREATE TABLE IF NOT EXISTS enhancement_links (
  id             TEXT PRIMARY KEY,
  enhancement_id TEXT NOT NULL REFERENCES enhancements(id) ON DELETE CASCADE,
  repo           TEXT NOT NULL,
  kind           TEXT NOT NULL,       -- issue|pull
  number         INTEGER NOT NULL,
  url            TEXT,
  title          TEXT,
  state          TEXT,                -- open|closed|merged
  merged         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (enhancement_id, repo, kind, number)
);
CREATE INDEX IF NOT EXISTS ix_enhancement_links_repo ON enhancement_links(repo, kind, number);

-- Append-only journal of bridge runs. Kept in the database so the panel can
-- show what the last push/pull actually did without relying on server logs
-- (Vercel log retention is short and a serverless instance is ephemeral).
CREATE TABLE IF NOT EXISTS enhancement_sync_events (
  id             TEXT PRIMARY KEY,
  direction      TEXT NOT NULL,       -- push|pull|full
  actor_name     TEXT,
  repo           TEXT,
  pulled         INTEGER NOT NULL DEFAULT 0,
  pushed         INTEGER NOT NULL DEFAULT 0,
  created        INTEGER NOT NULL DEFAULT 0,
  updated        INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  errors         TEXT,                -- JSON array of {ref, message}
  detail         TEXT,                -- JSON report
  at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_enhancement_sync_events_at ON enhancement_sync_events(at);
