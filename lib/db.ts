import { DatabaseSync } from "node:sqlite";
import * as nodeSqlite from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Thin, dependency-free data access layer over Node's built-in SQLite.
 * The SQL is deliberately portable: switch to Postgres/Neon in production by
 * swapping this module for a pg-backed implementation (see docs/DEPLOYMENT.md).
 */

type Param = string | number | null | bigint | Uint8Array;
export type Row = Record<string, any>;

const DB_FILE =
  process.env.DATABASE_FILE ??
  path.join(process.cwd(), "data", "qa-calendar.db");

const globalForDb = globalThis as unknown as {
  __qaDb?: DatabaseSync;
  __qaMigrated?: boolean;
};

function ensureDir(file: string) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getDb(): DatabaseSync {
  if (!globalForDb.__qaDb) {
    ensureDir(DB_FILE);
    const db = new DatabaseSync(DB_FILE);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    globalForDb.__qaDb = db;
  }
  if (!globalForDb.__qaMigrated) {
    migrate(globalForDb.__qaDb);
    globalForDb.__qaMigrated = true;
  }
  return globalForDb.__qaDb;
}

export function migrate(db: DatabaseSync = getDb()): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`
  );
  const dir = path.join(process.cwd(), "db", "migrations");
  if (!fs.existsSync(dir)) return [];
  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

function normalise(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as Param;
  });
}

/** node:sqlite returns null-prototype rows; copy them so Server Components can
 *  pass the data to Client Components. */
function plain<T>(row: unknown): T {
  return { ...(row as Record<string, unknown>) } as T;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  const rows = getDb().prepare(sql).all(...normalise(params));
  return rows.map((row) => plain<T>(row));
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  const row = getDb()
    .prepare(sql)
    .get(...normalise(params));
  return row ? plain<T>(row) : undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return getDb()
    .prepare(sql)
    .run(...normalise(params));
}

export function exec(sql: string) {
  getDb().exec(sql);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function setting(key: string, fallback = ""): string {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    value
  );
}

export const dbFile = DB_FILE;

/** Online backup (SQLite backup API) — safe while the app is running.
 *  The runtime ships `backup`; older @types/node releases omit the type. */
export async function backup(source: DatabaseSync, destination: string) {
  const fn = (nodeSqlite as unknown as {
    backup?: (db: DatabaseSync, dest: string) => Promise<void>;
  }).backup;
  if (!fn) throw new Error("node:sqlite backup API is unavailable in this Node version.");
  return fn(source, destination);
}
