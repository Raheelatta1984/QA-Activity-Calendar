import type { DatabaseSync } from "node:sqlite";
import {
  SERVERLESS,
  getSqlite,
  sqliteAll,
  sqliteBackup,
  sqliteEphemeral,
  sqliteExec,
  sqliteFile,
  sqliteGet,
  sqliteInfo,
  sqliteMigrate,
  sqliteRun,
  sqliteTransaction,
} from "./database/sqlite";
import {
  PG_BASELINE_THROUGH,
  PostgresBridge,
  createBridgeOptionsFromUrl,
  postgresMigrate,
} from "./database/postgres";
import { MIGRATIONS } from "../db/migrations.generated";

/**
 * The application's data layer.
 *
 * Two drivers behind one synchronous API:
 *
 *   • **sqlite** (default) — Node's built-in `node:sqlite`. Zero setup, perfect
 *     for local dev, tests, CI and air-gapped use. On a serverless platform the
 *     file lives in `/tmp`, so it is a *demo* store: data is lost when the
 *     instance recycles.
 *   • **postgres** — enabled by `DATABASE_URL=postgres://…` (Neon, Supabase,
 *     RDS, Vercel Postgres, a local Postgres…). Durable, shared across
 *     instances, and the recommended production store.
 *
 * The rest of the application only imports this module and keeps using the
 * same synchronous calls (`all`, `get`, `run`, `transaction`, …). Choosing a
 * driver is configuration; no feature code depends on the dialect.
 *
 * If `DATABASE_URL` is set but the Postgres bridge cannot start, the driver
 * falls back to SQLite and exposes the reason in `dbInfo()` and `/api/health`.
 * Set `DATABASE_REQUIRE_POSTGRES=true` in production to fail hard instead.
 */

export type Row = Record<string, any>;
export type DriverName = "sqlite" | "postgres";

type DriverGlobal = {
  __qaPg?: PostgresBridge | null;
  __qaPgError?: string | null;
  __qaPgMigrated?: boolean;
};

const globalForDb = globalThis as unknown as DriverGlobal;

function configuredUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!/^postgres(ql)?:\/\//i.test(url)) return null;
  if ((process.env.DATABASE_DRIVER ?? "").toLowerCase() === "sqlite") return null;
  return url;
}

/** True when a Postgres connection string is configured. */
export const postgresConfigured = !!configuredUrl();
/** True when the operator demands durable storage (no silent fallback). */
function postgresRequired() {
  return (process.env.DATABASE_REQUIRE_POSTGRES ?? "").toLowerCase() === "true";
}

function redact(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username ? `${parsed.username}@` : ""}${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres://(invalid url)";
  }
}

function postgres(): PostgresBridge | null {
  if (!postgresConfigured) return null;
  if (globalForDb.__qaPgError) return null;
  if (globalForDb.__qaPg) return globalForDb.__qaPg;
  try {
    const bridge = new PostgresBridge(createBridgeOptionsFromUrl(configuredUrl()!));
    // Force worker creation now so a broken bundle/URL is caught at startup and
    // can fall back *before* a page render writes to the wrong store.
    bridge.ping();
    globalForDb.__qaPg = bridge;
    console.info(`[db] Postgres driver active → ${redact(configuredUrl()!)}`);
    return bridge;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalForDb.__qaPgError = message;
    console.error(
      `[db] Postgres is configured but unavailable: ${message}\n` +
        `[db] ${postgresRequired() ? "DATABASE_REQUIRE_POSTGRES=true — refusing to start." : "Falling back to SQLite (data will NOT be durable)."}`
    );
    if (postgresRequired()) throw error;
    return null;
  }
}

/** Active driver name. Falls back to SQLite when Postgres cannot start. */
export function driverName(): DriverName {
  if (!postgresConfigured) return "sqlite";
  return postgres() ? "postgres" : "sqlite";
}

/** Last driver-level failure (shown by /api/health and the app banner). */
export function driverError(): string | null {
  return globalForDb.__qaPgError ?? null;
}

/** Active SQLite file, or `null` when Postgres is serving the data. */
export const dbFile: string = sqliteFile;

/**
 * True when rows live on ephemeral storage (a serverless `/tmp` SQLite file).
 * Durable Postgres storage is never ephemeral.
 */
export const dbEphemeral: boolean = postgresConfigured
  ? !postgresRequired() && !!globalForDb.__qaPgError
  : sqliteEphemeral;

export function dbInfo() {
  const url = configuredUrl();
  const driver = driverName();
  return {
    ...(driver === "postgres"
      ? { file: null, ephemeral: false, serverless: SERVERLESS }
      : sqliteInfo()),
    driver,
    durable: driver === "postgres",
    target: driver === "postgres" && url ? redact(url) : sqliteInfo().file,
    baseline: driver === "postgres" ? PG_BASELINE_THROUGH : null,
    fallbackReason: driver === "postgres" ? null : driverError(),
  };
}

/** Present for compatibility with the SQLite-only scripts. */
export function getDb(): DatabaseSync {
  if (driverName() === "postgres") {
    throw new Error(
      "getDb() exposes the raw SQLite handle and is unavailable on Postgres. " +
        "Use all/get/run from lib/db, or pg_dump for backups."
    );
  }
  return getSqlite();
}

function normalise(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (param === undefined) return null;
    if (typeof param === "boolean") return param ? 1 : 0;
    return param;
  });
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  const bridge = postgres();
  if (bridge) return bridge.all<T>(sql, normalise(params));
  return sqliteAll<T>(sql, ...params);
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  const bridge = postgres();
  if (bridge) return bridge.get<T>(sql, normalise(params));
  return sqliteGet<T>(sql, ...params);
}

export function run(sql: string, ...params: unknown[]) {
  const bridge = postgres();
  if (bridge) {
    const result = bridge.run(sql, normalise(params));
    return { changes: result.changes, lastInsertRowid: null };
  }
  return sqliteRun(sql, ...params);
}

export function exec(sql: string) {
  const bridge = postgres();
  if (bridge) return bridge.exec(sql);
  return sqliteExec(sql);
}

export function transaction<T>(fn: () => T): T {
  const bridge = postgres();
  if (bridge) {
    bridge.begin();
    try {
      const result = fn();
      bridge.commit();
      return result;
    } catch (error) {
      bridge.rollback();
      throw error;
    }
  }
  return sqliteTransaction(fn);
}

/** Apply migrations. Postgres uses the generated baseline + additive deltas. */
export function migrate(_db?: DatabaseSync): string[] {
  const bridge = postgres();
  if (bridge) {
    if (globalForDb.__qaPgMigrated) return [];
    const ran = postgresMigrate(bridge, MIGRATIONS);
    globalForDb.__qaPgMigrated = true;
    return ran;
  }
  return sqliteMigrate();
}

/** Ensure a connection exists and the schema is present (used by scripts). */
export function initDb() {
  if (driverName() === "postgres") {
    migrate();
    return null;
  }
  const db = getSqlite();
  migrate(db);
  return db;
}

/** Table count without dialect-specific catalogues (health probe, changelog). */
export function tableCount(): number {
  const row =
    driverName() === "postgres"
      ? get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()`
        )
      : get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`);
  return Number(row?.n ?? 0);
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

/** Online backup. SQLite only — Postgres uses pg_dump / the provider's backup. */
export async function backup(source: DatabaseSync, destination: string) {
  if (driverName() === "postgres") {
    throw new Error("Backups on Postgres are taken with pg_dump or the provider's managed backups, not this command.");
  }
  return sqliteBackup(source, destination);
}

export { PG_BASELINE_THROUGH };
