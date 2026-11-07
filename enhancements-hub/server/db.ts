/**
 * Thin, dependency-free data access layer over Node's built-in SQLite
 * (node:sqlite, Node 22+). Ported from the source application's lib/db.ts and
 * reduced to what the hub needs: the file location is resolved once, the schema
 * is applied idempotently on first use, and read-only or serverless filesystems
 * fall back to a writable temp directory so a cold start never crashes.
 *
 * Swap this single file for a Postgres-backed implementation to move storage —
 * nothing else in the hub imports node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_SQL, UPGRADES } from "./schema.ts";

export type Row = Record<string, any>;
type Param = string | number | null | bigint | Uint8Array;

const TMP = os.tmpdir();
const SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.CF_PAGES
);

function defaultDbFile(): string {
  const configured = process.env.DATABASE_FILE?.trim() || process.env.HUB_DB_FILE?.trim();
  if (configured) return path.resolve(configured);
  if (SERVERLESS) return path.join(TMP, "enhancements-hub.db");
  return path.join(process.cwd(), "data", "enhancements-hub.db");
}

let dbFile = defaultDbFile();
let db: DatabaseSync | null = null;
let initialised = false;

function open(): DatabaseSync {
  if (db) return db;
  const candidates = SERVERLESS
    ? [dbFile, path.join(TMP, "enhancements-hub.db"), path.join(TMP, `enhancements-hub-${Date.now()}.db`)]
    : [dbFile, path.join(TMP, `enhancements-hub-${Date.now()}.db`)];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      db = new DatabaseSync(candidate);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      dbFile = candidate;
      break;
    } catch (error) {
      if (candidate === candidates[candidates.length - 1]) throw error;
      console.warn(`[hub] database ${candidate} unavailable (${(error as Error).message}); trying fallback.`);
    }
  }
  return db as DatabaseSync;
}

function ensureSchema(): void {
  if (initialised) return;
  const handle = open();
  handle.exec(SCHEMA_SQL);
  for (const upgrade of UPGRADES) {
    const applied = handle
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'hub.upgrade' AND entity_id = ?`)
      .get(upgrade.version) as { n: number } | undefined;
    if ((applied?.n ?? 0) > 0) continue;
    handle.exec(upgrade.sql);
    handle
      .prepare(
        `INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, after_json)
         VALUES (?, NULL, 'system', 'hub.upgrade', 'schema', ?, ?)`
      )
      .run(`upg_${upgrade.version}`, upgrade.version, JSON.stringify({ version: upgrade.version }));
  }
  initialised = true;
}

export function databaseFile(): string {
  ensureSchema();
  return dbFile;
}

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  ensureSchema();
  return db!.prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  ensureSchema();
  return db!.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number | bigint } {
  ensureSchema();
  return db!.prepare(sql).run(...params);
}

/** Test/adjacent-process helper: point the hub at a specific database file. */
export function useDatabaseFile(file: string): void {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
  initialised = false;
  dbFile = path.resolve(file);
}
