import { Worker } from "node:worker_threads";
import path from "node:path";
import { toPostgres } from "./dialect";
import { buildPostgresSchema } from "./pg-schema";

/**
 * PostgreSQL driver with a **synchronous** facade.
 *
 * The application's data layer is synchronous end to end (Node's `node:sqlite`
 * is synchronous, and page renders / server actions call it directly). A
 * network database client is asynchronous, so this module bridges the two:
 *
 *   main thread ──postMessage──▶ worker thread ──▶ pg Pool ──▶ Postgres
 *        ▲                            │
 *        └──── SharedArrayBuffer ◀────┘   (Atomics.wait / Atomics.notify)
 *
 * The main thread blocks on `Atomics.wait` for the duration of one round-trip,
 * which is exactly the semantics a synchronous driver needs. The worker owns
 * the connection pool, so connections are reused across requests within an
 * instance. This keeps every existing query and call site unchanged.
 *
 * Failure policy: if the bridge cannot start (worker blocked by the platform,
 * `pg` missing from the bundle, bad URL) the error is recorded and the facade
 * falls back to SQLite with a visible warning in the UI and /api/health, rather
 * than taking the whole application down. Set `DATABASE_REQUIRE_POSTGRES=true`
 * to fail hard instead — recommended for production.
 */

const HEADER_BYTES = 16;
const PAYLOAD_BYTES = Math.max(4 * 1024 * 1024, Number(process.env.PG_BRIDGE_PAYLOAD_BYTES ?? 64 * 1024 * 1024));

/** Migrations up to and including this file are represented by the generated
 *  Postgres baseline; later (additive) migrations are applied statement by
 *  statement. Bump this deliberately when adding a new baseline. */
export const PG_BASELINE_THROUGH = "005_release_planning.sql";
export const PG_BASELINE_NAME = `pg-baseline@${PG_BASELINE_THROUGH}`;

type BridgeResponse = {
  rows?: Record<string, unknown>[];
  row?: Record<string, unknown> | null;
  changes?: number;
  error?: string;
};

export type PostgresBridgeOptions = {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  /** Base file used to resolve `pg` from the application's node_modules. */
  requireBase?: string;
  timeoutMs?: number;
};

/** Worker source. Kept as a string so the bundler cannot rewrite the entry. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");

function loadPg() {
  const bases = [workerData.requireBase, process.env.PG_REQUIRE_BASE, require("node:path").join(process.cwd(), "index.js")];
  let lastError;
  for (const base of bases) {
    if (!base) continue;
    try {
      return createRequire(base)("pg");
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return require("pg");
  } catch (error) {
    lastError = error;
  }
  throw lastError ?? new Error("pg is not installed");
}

let pg;
try {
  pg = loadPg();
} catch (error) {
  parentPort.postMessage({ bootError: String(error && error.message ? error.message : error) });
  throw error;
}

// SQLite returns numbers for COUNT/SUM; pg returns int8/numeric as strings.
pg.types.setTypeParser(20, (value) => Number(value));   // int8
pg.types.setTypeParser(1700, (value) => Number(value)); // numeric
pg.types.setTypeParser(700, (value) => Number(value));  // float4
pg.types.setTypeParser(701, (value) => Number(value));  // float8

const sab = workerData.sab;
const HEADER = workerData.HEADER;
const signal = new Int32Array(sab, 0, 4);
const out = new Uint8Array(sab, HEADER);

function reply(payload) {
  let bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.length > out.length) {
    bytes = Buffer.from(
      JSON.stringify({
        error:
          "Postgres result is larger than the synchronous bridge buffer (" +
          bytes.length +
          " bytes). Add a LIMIT or page the query.",
      }),
      "utf8"
    );
  }
  out.set(bytes, 0);
  Atomics.store(signal, 1, bytes.length);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

const pool = new pg.Pool({
  connectionString: workerData.connectionString,
  max: workerData.max,
  ssl: workerData.ssl ? { rejectUnauthorized: false } : undefined,
  application_name: "qa-activity-calendar",
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on("error", () => {
  // Idle client errors are reported by the query that needs the connection.
});

let tx = null;
let depth = 0;

parentPort.on("message", async (message) => {
  try {
    const { op, sql, params, mode } = message;
    if (op === "query") {
      const executor = tx ?? pool;
      const result = await executor.query(sql, params ?? []);
      if (mode === "all") return reply({ rows: result.rows });
      if (mode === "get") return reply({ row: result.rows[0] ?? null });
      return reply({ changes: result.rowCount ?? 0, rows: result.rows });
    }
    if (op === "exec") {
      // Inside a transaction (migrations, imports) the reserved client must be
      // used, otherwise a small pool deadlocks waiting for its only connection.
      await (tx ?? pool).query(sql);
      return reply({});
    }
    if (op === "begin") {
      if (tx) {
        depth += 1;
        return reply({});
      }
      tx = await pool.connect();
      await tx.query("BEGIN");
      depth = 1;
      return reply({});
    }
    if (op === "commit") {
      depth -= 1;
      if (depth > 0) return reply({});
      const client = tx;
      tx = null;
      depth = 0;
      await client.query("COMMIT");
      client.release();
      return reply({});
    }
    if (op === "rollback") {
      const client = tx;
      tx = null;
      depth = 0;
      if (client) {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
      return reply({});
    }
    if (op === "ping") {
      const result = await pool.query("SELECT 1 AS ok");
      return reply({ rows: result.rows });
    }
    if (op === "close") {
      await pool.end();
      return reply({});
    }
    return reply({ error: "Unknown bridge operation: " + op });
  } catch (error) {
    reply({ error: String(error && error.message ? error.message : error) });
  }
});
`;

export class PostgresBridge {
  private worker: Worker | null = null;
  private signal: Int32Array | null = null;
  private payload: Uint8Array | null = null;
  private sequence = 0;
  private bootError: string | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly options: PostgresBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? Number(process.env.PG_BRIDGE_TIMEOUT_MS ?? 20000);
  }

  get error(): string | null {
    return this.bootError;
  }

  get connected(): boolean {
    return !!this.worker && !this.bootError;
  }

  private start() {
    if (this.worker) return;
    if (this.bootError) throw new Error(this.bootError);
    const sab = new SharedArrayBuffer(HEADER_BYTES + PAYLOAD_BYTES);
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        connectionString: this.options.connectionString,
        max: this.options.max ?? 5,
        ssl: this.options.ssl ?? true,
        requireBase:
          this.options.requireBase ?? path.join(process.cwd(), "package.json"),
        HEADER: HEADER_BYTES,
      },
      env: { ...process.env },
    });
    worker.on("error", (error) => {
      this.bootError = `Postgres bridge worker failed: ${error.message}`;
      console.error(`[db:postgres] ${this.bootError}`);
    });
    // The worker reports a fatal boot problem (pg missing, bad URL) before it
    // exits; recording it here turns a 20s silent timeout into a clear message.
    worker.on("message", (message: { bootError?: string } | undefined) => {
      if (message && typeof message.bootError === "string") {
        this.bootError = `Postgres bridge could not start: ${message.bootError}`;
        console.error(`[db:postgres] ${this.bootError}`);
        Atomics.store(this.signal!, 0, 1);
        Atomics.notify(this.signal!, 0);
      }
    });
    worker.on("exit", (code) => {
      if (!this.bootError && code !== 0) {
        this.bootError = `Postgres bridge worker exited with code ${code} before answering.`;
      }
    });
    worker.unref();
    this.worker = worker;
    this.signal = new Int32Array(sab, 0, 4);
    this.payload = new Uint8Array(sab, HEADER_BYTES);
  }

  private call(op: string, payload: Record<string, unknown> = {}): BridgeResponse {
    this.start();
    if (!this.worker || !this.signal) throw new Error(this.bootError ?? "Postgres bridge is not running");
    const id = ++this.sequence;
    Atomics.store(this.signal, 0, 0);
    Atomics.store(this.signal, 1, 0);
    this.worker.postMessage({ id, op, ...payload });
    const waited = Atomics.wait(this.signal, 0, 0, this.timeoutMs);
    if (waited === "timed-out") {
      throw new Error(
        `Postgres did not answer within ${this.timeoutMs}ms. Check DATABASE_URL, network access and pool limits.`
      );
    }
    const length = Atomics.load(this.signal, 1);
    const text = Buffer.from(this.signal.buffer as unknown as ArrayBuffer, HEADER_BYTES, length).toString("utf8");
    let response: BridgeResponse;
    try {
      response = JSON.parse(text) as BridgeResponse;
    } catch {
      throw new Error("Postgres bridge returned an unreadable response.");
    }
    if (response.error) throw new Error(`Postgres: ${response.error}`);
    return response;
  }

  all<T>(sql: string, params: unknown[]): T[] {
    return (this.call("query", { sql: toPostgres(sql), params, mode: "all" }).rows ?? []) as T[];
  }

  get<T>(sql: string, params: unknown[]): T | undefined {
    const response = this.call("query", { sql: toPostgres(sql), params, mode: "get" });
    return (response.row ?? undefined) as T | undefined;
  }

  run(sql: string, params: unknown[]): { changes: number } {
    return { changes: this.call("query", { sql: toPostgres(sql), params, mode: "run" }).changes ?? 0 };
  }

  exec(sql: string): void {
    const translated = toPostgres(sql);
    if (!translated.trim()) return;
    this.call("exec", { sql: translated });
  }

  begin() {
    this.call("begin");
  }

  commit() {
    this.call("commit");
  }

  rollback() {
    this.call("rollback");
  }

  ping() {
    return this.call("ping");
  }
}

/** Offline/unit-test seam: build a bridge against any async executor. */
export function createBridgeOptionsFromUrl(connectionString: string): PostgresBridgeOptions {
  const sslDisabled = /sslmode=disable/i.test(connectionString) || /localhost|127\.0\.0\.1/i.test(connectionString);
  return {
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    ssl: !sslDisabled,
    requireBase: path.join(process.cwd(), "package.json"),
  };
}

/**
 * Apply the Postgres schema: the generated baseline (migrations up to
 * `PG_BASELINE_THROUGH`) once, then any newer additive migration, tracked in
 * the same `_migrations` ledger the SQLite driver uses.
 */
export function postgresMigrate(bridge: PostgresBridge, migrations: { name: string; sql: string }[]): string[] {
  bridge.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
  );
  const applied = new Set(bridge.all<{ name: string }>(`SELECT name FROM _migrations`, []).map((row) => row.name));
  const ran: string[] = [];

  if (!applied.has(PG_BASELINE_NAME)) {
    const schema = buildPostgresSchema(PG_BASELINE_THROUGH);
    bridge.begin();
    try {
      for (const statement of schema.statements) bridge.exec(statement);
      for (const migration of migrations.filter((item) => item.name <= PG_BASELINE_THROUGH)) {
        bridge.run(`INSERT INTO _migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [migration.name]);
      }
      bridge.run(`INSERT INTO _migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [PG_BASELINE_NAME]);
      bridge.commit();
    } catch (error) {
      bridge.rollback();
      throw error;
    }
    ran.push(PG_BASELINE_NAME);
  }

  // Post-baseline migrations must stay additive (see lib/db/pg-schema.ts).
  for (const migration of migrations) {
    if (migration.name <= PG_BASELINE_THROUGH) continue;
    if (applied.has(migration.name)) continue;
    bridge.begin();
    try {
      bridge.exec(migration.sql);
      bridge.run(`INSERT INTO _migrations (name) VALUES (?)`, [migration.name]);
      bridge.commit();
    } catch (error) {
      bridge.rollback();
      throw new Error(`Migration ${migration.name} failed on Postgres: ${(error as Error).message}`);
    }
    ran.push(migration.name);
  }
  return ran;
}
