-- ===========================================================================
-- 005_release_planning.sql — release QA windows, assignees and FTE
--
-- A release used to carry a single feed date. Planning QA effort needs the
-- *window* the work occupies and the *people* who do it, otherwise the release
-- cannot contribute FTE demand to the QA calendar or the FTE calendar.
--
-- Design notes
--   * The window lives on release_feed (one window per release, inclusive
--     date-only fields — NULL means "not planned yet", never "zero").
--   * Assignees are their own table so a release can be covered by several
--     people, each with their own FTE share. The share is FTE demand per
--     working day, not FTE-days: FTE-days = Σ share × working days.
--   * No FK to activities: a release is release governance, not an activity.
--     The calendar and FTE projections merge the release rows at read time,
--     so a release can never masquerade as an activity record.
-- ===========================================================================

ALTER TABLE release_feed ADD COLUMN qa_start_date TEXT; -- inclusive QA window start
ALTER TABLE release_feed ADD COLUMN qa_end_date TEXT;   -- inclusive QA window end
ALTER TABLE release_feed ADD COLUMN qa_owner_id TEXT REFERENCES people(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS release_assignees (
  id         TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES release_feed(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'QA',
  fte        REAL NOT NULL DEFAULT 0.5,   -- FTE demand per working day
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (release_id, person_id)
);

CREATE INDEX IF NOT EXISTS ix_release_assignees_release ON release_assignees(release_id);
CREATE INDEX IF NOT EXISTS ix_release_assignees_person ON release_assignees(person_id);
CREATE INDEX IF NOT EXISTS ix_release_feed_window ON release_feed(qa_start_date, qa_end_date);
