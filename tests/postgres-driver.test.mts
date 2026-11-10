import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * End-to-end check of the Postgres driver *through its synchronous bridge*.
 *
 * A real Postgres server is not available in CI, so the test starts PGlite
 * (Postgres compiled to WASM) behind the Postgres wire protocol **in a child
 * process** — it must be out-of-process, because the driver deliberately blocks
 * the main thread in `Atomics.wait` while waiting for a reply.
 * That exercises the parts that unit tests cannot:
 * worker start-up, `Atomics.wait` round-trips, the pool, schema migration,
 * transactions and the SQL translation on a genuine Postgres parser.
 *
 * When `@electric-sql/pglite-socket` is not installed the test skips, so the
 * suite still runs anywhere.
 */

process.env.DATABASE_FILE = path.join(os.tmpdir(), `qa-calendar-pgdriver-${process.pid}.db`);
process.env.SEED_DEMO_DATA = "false";
process.env.PG_POOL_MAX = "1";
delete process.env.DATABASE_URL;
delete process.env.DATABASE_REQUIRE_POSTGRES;

test("Postgres driver: synchronous bridge migrates and queries a real Postgres", async (t) => {
  try {
    await import("@electric-sql/pglite");
    await import("@electric-sql/pglite-socket");
  } catch {
    t.skip("PGlite socket server is not installed — skipping the live Postgres driver test");
    return;
  }

  const port = 55100 + Math.floor(Math.random() * 400);
  const serverSource = `
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const db = new PGlite();
    const server = new PGLiteSocketServer({ db, port: ${port}, host: "127.0.0.1" });
    await server.start();
    console.log("listening");
    process.on("SIGTERM", async () => {
      try { await server.stop(); await db.close(); } catch {}
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const serverProcess = spawn(process.execPath, ["--input-type=module", "-e", serverSource], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PGlite server did not start within 30s")), 30000);
      let log = "";
      serverProcess.stdout.on("data", (chunk) => {
        log += String(chunk);
        if (log.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProcess.stderr.on("data", (chunk) => {
        log += String(chunk);
      });
      serverProcess.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`PGlite server exited early (code ${code}): ${log.slice(0, 400)}`));
      });
    });
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

    // Imported after DATABASE_URL is set: the driver chooses its backend at
    // first use, exactly as it does at runtime.
    const db = await import("../lib/db");

    const applied = db.migrate();
    assert.equal(db.driverName(), "postgres");
    assert.ok(applied.length >= 1, "the Postgres baseline is applied once");
    assert.equal(db.migrate().length, 0, "a second migrate is a no-op");
    assert.equal(db.dbInfo().durable, true);
    assert.equal(db.dbInfo().ephemeral, false);

    db.run(`INSERT INTO companies (id, name) VALUES (?, ?)`, "co_pg", "Postgres Co");
    db.run(
      `INSERT INTO departments (id, company_id, code, name) VALUES (?, ?, ?, ?)`,
      "dept_pg",
      "co_pg",
      "QA",
      "Quality Engineering"
    );
    const department = db.get<{ name: string }>(
      `SELECT name FROM departments WHERE name LIKE ? AND company_id = ?`,
      "%quality%",
      "co_pg"
    );
    assert.equal(department?.name, "Quality Engineering");

    // Timestamps default to SQLite-compatible text.
    const created = db.get<{ created_at: string }>(`SELECT created_at FROM departments WHERE id = ?`, "dept_pg");
    assert.match(String(created?.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Constrained write must surface the database error, not swallow it.
    assert.throws(
      () => db.run(`INSERT INTO companies (id, name) VALUES (?, ?)`, "co_pg", "Duplicate"),
      /duplicate key|unique/i
    );

    // Transactions commit and roll back through the same worker connection.
    db.transaction(() => {
      db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, "pg.test", "committed");
    });
    assert.equal(db.setting("pg.test"), "committed");

    assert.throws(() =>
      db.transaction(() => {
        db.run(`INSERT INTO settings (key, value) VALUES (?, ?)`, "pg.rollback", "gone");
        throw new Error("rollback please");
      })
    );
    assert.equal(db.setting("pg.rollback"), "");

    // Null-safe comparison used by the seed and the validation queue.
    db.run(
      `INSERT INTO sticky_notes (id, tab_id, section_id, content, ai_generated) VALUES (?, NULL, NULL, ?, 1)`,
      "note_pg",
      "guidance"
    );
    assert.ok(
      db.get<{ id: string }>(
        `SELECT id FROM sticky_notes WHERE section_id IS ? AND ai_generated = 1 LIMIT 1`,
        null
      )
    );

    assert.ok(db.tableCount() > 30);
  } finally {
    serverProcess.kill("SIGTERM");
    delete process.env.DATABASE_URL;
  }
});
