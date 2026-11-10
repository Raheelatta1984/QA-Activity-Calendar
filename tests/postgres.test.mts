import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated database for the parity check (the module is imported lazily below).
const dbPath = path.join(os.tmpdir(), `qa-calendar-pg-test-${process.pid}.db`);
process.env.DATABASE_FILE = dbPath;
process.env.SEED_DEMO_DATA = "false";

const { toPostgres, placeholderCount, UnsupportedSqlError } = await import("../lib/database/dialect");
const { buildPostgresSchema } = await import("../lib/database/pg-schema");
const { MIGRATIONS } = await import("../db/migrations.generated");

test("translation: positional placeholders become $n and quoted literals are untouched", () => {
  assert.equal(
    toPostgres(`SELECT * FROM people WHERE name = ? AND notes = 'what?' AND id = ?`),
    `SELECT * FROM people WHERE name = $1 AND notes = 'what?' AND id = $2`
  );
  assert.equal(placeholderCount(`SELECT '?' AS a, ? AS b`), 1);
});

test("translation: INSERT OR IGNORE becomes ON CONFLICT DO NOTHING", () => {
  assert.equal(
    toPostgres(`INSERT OR IGNORE INTO holidays (id, date) VALUES (?, ?)`),
    `INSERT INTO holidays (id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING`
  );
});

test("translation: SQLite time helpers produce the same text timestamps", () => {
  const translated = toPostgres(`INSERT INTO audit_events (id, at) VALUES (?, datetime('now'))`);
  assert.match(translated, /to_char\(now\(\) at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'\)/);
  assert.doesNotMatch(translated, /datetime\('now'\)/);
  assert.equal(toPostgres(`SELECT date('now')`), `SELECT to_char(now() at time zone 'utc', 'YYYY-MM-DD')`);
});

test("translation: LIKE is case-insensitive in Postgres (ILIKE)", () => {
  assert.equal(
    toPostgres(`SELECT * FROM activities WHERE activity LIKE ? AND detail NOT LIKE ?`),
    `SELECT * FROM activities WHERE activity ILIKE $1 AND detail NOT ILIKE $2`
  );
});

test("translation: PRAGMA statements disappear", () => {
  assert.equal(toPostgres("PRAGMA foreign_keys = OFF;"), "");
});

test("translation: SQLite-only constructs fail loudly instead of silently misbehaving", () => {
  assert.throws(() => toPostgres(`SELECT * FROM changelog ORDER BY rowid DESC`), UnsupportedSqlError);
  assert.throws(() => toPostgres(`SELECT name FROM sqlite_master`), UnsupportedSqlError);
  assert.throws(() => toPostgres(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`), UnsupportedSqlError);
});

test("schema: the Postgres baseline is generated from the real migrations", () => {
  const schema = buildPostgresSchema();
  assert.ok(schema.tables.length > 30, `expected the full schema, got ${schema.tables.length} tables`);
  assert.ok(schema.tables.includes("release_assignees"));
  assert.ok(schema.tables.includes("activities"));

  // Foreign keys are re-attached with ALTER TABLE (Postgres has no forward
  // references inside CREATE TABLE) and never left inline.
  for (const statement of schema.statements.filter((sql) => sql.startsWith("CREATE TABLE"))) {
    assert.doesNotMatch(statement, /\bREFERENCES\b/i, `inline REFERENCES left in: ${statement.slice(0, 120)}`);
  }
  const foreignKeyStatements = schema.statements.filter((sql) => sql.startsWith("ALTER TABLE"));
  assert.equal(foreignKeyStatements.length, schema.foreignKeys.length);
  assert.ok(foreignKeyStatements.some((sql) => /release_assignees/.test(sql)));
});

test("schema: a real Postgres parse/execute accepts the baseline (PGlite)", async (t) => {
  let PGlite: any;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    t.skip("PGlite is not installed — skipping the live Postgres parse test");
    return;
  }

  const schema = buildPostgresSchema();
  const pg = new PGlite();
  try {
    for (const statement of schema.statements) {
      try {
        await pg.exec(statement);
      } catch (error) {
        assert.fail(`Postgres rejected generated DDL: ${(error as Error).message}\n${statement.slice(0, 300)}`);
      }
    }

    // Column parity with the SQLite schema that produced the baseline.
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys = OFF;");
      for (const migration of MIGRATIONS) sqlite.exec(migration.sql);
      const sqliteTables = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' ORDER BY name`
        )
        .all() as { name: string }[];
      const columns = await pg.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
      );
      const pgColumns = new Map<string, string[]>();
      for (const row of columns.rows) {
        pgColumns.set(row.table_name, [...(pgColumns.get(row.table_name) ?? []), row.column_name]);
      }
      for (const table of sqliteTables) {
        const expected = (sqlite.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[])
          .map((column) => column.name)
          .sort();
        const actual = (pgColumns.get(table.name) ?? []).slice().sort();
        assert.deepEqual(actual, expected, `column mismatch for ${table.name}`);
      }
    } finally {
      sqlite.close();
    }

    // Representative statements the application actually emits, translated the
    // same way the driver translates them at runtime.
    await pg.query(toPostgres(`INSERT INTO companies (id, name) VALUES (?, ?)`), ["co_t", "Test Co"]);
    await pg.query(
      toPostgres(`INSERT INTO departments (id, company_id, code, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))`),
      ["dept_t", "co_t", "QA", "Quality Engineering"]
    );
    const department = await pg.query<{ code: string; created_at: string }>(
      toPostgres(`SELECT code, created_at FROM departments WHERE name LIKE ? LIMIT ?`),
      ["%quality%", 5]
    );
    assert.equal(department.rows.length, 1);
    assert.match(department.rows[0].created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Upsert used by setSetting / the enhancement bridge.
    const upsert = toPostgres(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    await pg.query(upsert, ["fte.default_value", "0.5"]);
    await pg.query(upsert, ["fte.default_value", "0.6"]);
    const setting = await pg.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fte.default_value'`);
    assert.equal(setting.rows[0].value, "0.6");

    // INSERT OR IGNORE (holiday import) must be idempotent.
    const ignore = toPostgres(
      `INSERT OR IGNORE INTO holidays (id, date, name, jurisdiction, year) VALUES (?, ?, ?, 'NSW', ?)`
    );
    await pg.query(ignore, ["h1", "2030-01-01", "New Year", 2030]);
    await pg.query(ignore, ["h1", "2030-01-01", "New Year", 2030]);
    const holidays = await pg.query<{ n: number }>(`SELECT COUNT(*) AS n FROM holidays`);
    assert.equal(Number(holidays.rows[0].n), 1);

    // Aggregates must come back as numbers, not strings (pg int8/numeric).
    const count = await pg.query<{ n: number }>(`SELECT COUNT(*) AS n FROM departments`);
    assert.equal(typeof Number(count.rows[0].n), "number");
  } finally {
    await pg.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});
