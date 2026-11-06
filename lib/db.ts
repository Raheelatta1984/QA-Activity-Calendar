import { DatabaseSync } from "node:sqlite";
import * as nodeSqlite from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS } from "../db/migrations.generated";

/**
 * Thin, dependency-free data access layer over Node's built-in SQLite.
 * The SQL is deliberately portable: switch to Postgres/Neon in production by
 * swapping this module for a pg-backed implementation (see docs/DEPLOYMENT.md).
 *
 * Serverless note: Vercel/Lambda give the function a read-only bundle and a
 * writable /tmp. We therefore default to /tmp when a serverless runtime is
 * detected (or when the configured path turns out to be unwritable) and fall
 * back to the migration SQL embedded at build time, so a cold start never
 * depends on files that were not traced into the bundle.
 */

type Param = string | number | null | bigint | Uint8Array;
export type Row = Record<string, any>;

const TMP = os.tmpdir();
const SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.CF_PAGES
);

function defaultDbFile(): string {
  const configured = process.env.DATABASE_FILE?.trim();
  if (configured) return path.resolve(configured);
  if (SERVERLESS) return path.join(TMP, "qa-calendar.db");
  return path.join(process.cwd(), "data", "qa-calendar.db");
}

/** Active database file. May change once at startup if the path is read-only. */
export let dbFile = defaultDbFile();
/** True when rows live on ephemeral storage (serverless) — data resets. */
export let dbEphemeral = SERVERLESS || dbFile === path.join(TMP, "qa-calendar.db");

const globalForDb = globalThis as unknown as {
  __qaDb?: DatabaseSync;
  __qaMigrated?: boolean;
};

function writable(file: string): boolean {
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) {
      // Only create directories inside the project or the OS temp dir; a
      // non-existent path elsewhere (e.g. a read-only mount) is treated as
      // unusable rather than attempted.
      const local = dir === process.cwd() || dir.startsWith(`${process.cwd()}${path.sep}`) || dir.startsWith(TMP);
      if (!local) return false;
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function openAt(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Open the configured file, or /tmp when the runtime filesystem is read-only. */
function openDatabase(): DatabaseSync {
  if (writable(dbFile)) return openAt(dbFile);
  const fallback = path.join(TMP, "qa-calendar.db");
  console.warn(
    `[db] ${dbFile} is not writable in this runtime; falling back to ${fallback}. ` +
      `Data is per-instance and resets with the function — configure DATABASE_URL/Postgres for durable storage.`
  );
  dbFile = fallback;
  dbEphemeral = true;
  if (!writable(fallback)) {
    throw new Error(
      `No writable location for the SQLite database (tried ${dbFile} and ${fallback}). ` +
        `Set DATABASE_FILE to a writable path, or run with a Postgres adapter.`
    );
  }
  if (globalForDb.__qaMigrated) globalForDb.__qaMigrated = false;
  return openAt(fallback);
}

export function dbInfo() {
  return { file: dbFile, ephemeral: dbEphemeral, serverless: SERVERLESS };
}

export function getDb(): DatabaseSync {
  if (!globalForDb.__qaDb) {
    globalForDb.__qaDb = openDatabase();
  }
  if (!globalForDb.__qaMigrated) {
    migrate(globalForDb.__qaDb);
    globalForDb.__qaMigrated = true;
  }
  return globalForDb.__qaDb;
}

/** Migration SQL: files on disk when available (dev), embedded at build time otherwise. */
function migrationSources(): { name: string; sql: string }[] {
  const dir = path.join(process.cwd(), "db", "migrations");
  try {
    if (fs.existsSync(dir)) {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      if (files.length) {
        return files.map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
      }
    }
  } catch {
    /* fall through to the embedded copy below */
  }
  return MIGRATIONS;
}

export function migrate(db: DatabaseSync = getDb()): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`
  );
  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );
  const ran: string[] = [];
  for (const { name: file, sql } of migrationSources()) {
    if (applied.has(file)) continue;
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

/** Online backup (SQLite backup API) — safe while the app is running.
 *  The runtime ships `backup`; older @types/node releases omit the type. */
export async function backup(source: DatabaseSync, destination: string) {
  const fn = (nodeSqlite as unknown as {
    backup?: (db: DatabaseSync, dest: string) => Promise<void>;
  }).backup;
  if (!fn) throw new Error("node:sqlite backup API is unavailable in this Node version.");
  return fn(source, destination);
}
