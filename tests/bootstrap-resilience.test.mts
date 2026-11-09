import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bootstrap resilience.
 *
 * Two real failures found in review are pinned here, both caused by work that
 * arrives *outside* the demo seed:
 *
 *  1. A proposal imported by the GitHub bridge can hold a ref the demo seed also
 *     wants (`ENH-0002`). Seeding used to abort on the `enhancements.ref` UNIQUE
 *     index; the exception escaped the transaction and failed the Next.js
 *     prerender of `/_not-found`, which took down `npm run build`.
 *  2. A bootstrap whose guard sat outside the write transaction let two
 *     processes both decide to seed (Next.js builds with parallel workers).
 *
 * The first is tested directly; the second is now guarded inside the
 * transaction, so the observable contract is simply "bootstrap twice is safe".
 */

function freshDatabase(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-bootstrap-${label}-`));
  return path.join(dir, "qa.db");
}

test("a proposal holding a seeded ref does not break the demo seed", async () => {
  const file = freshDatabase("refclash");
  process.env.DATABASE_FILE = file;
  process.env.SEED_DEMO_DATA = "true";

  const { bootstrapDatabase } = await import("../lib/seed");
  const { run, get } = await import("../lib/db");
  const { migrate } = await import("../lib/db");

  // Reference config only: enough tables to insert the colliding proposal.
  migrate();
  run(
    `INSERT INTO enhancements (id, ref, title, brief, status, source, github_repo, github_issue_number, created_at, updated_at)
     VALUES ('enh_from_github', 'ENH-0002', 'Imported issue', 'from GitHub', 'Submitted', 'github', 'owner/repo', 42, datetime('now'), datetime('now'))`
  );

  // This is the call that used to throw "UNIQUE constraint failed: enhancements.ref".
  const result = bootstrapDatabase();
  assert.equal(result.createdDemo, true);

  // The real proposal wins over demo data — it is never overwritten or removed.
  const kept = get<{ id: string; title: string; source: string }>(
    `SELECT id, title, source FROM enhancements WHERE ref = 'ENH-0002'`
  );
  assert.equal(kept?.id, "enh_from_github");
  assert.equal(kept?.title, "Imported issue");
  assert.equal(kept?.source, "github");

  // The seed still produced its own proposals under refs it could take.
  const seeded = get<{ n: number }>(`SELECT COUNT(*) AS n FROM enhancements WHERE id LIKE 'enh_seed_%'`);
  assert.equal(Number(seeded?.n), 2, "ENH-0001 and ENH-0003 seed; ENH-0002 belongs to the import");

  // Bootstrapping again is a no-op, not a second seed.
  const second = bootstrapDatabase();
  assert.equal(second.createdDemo, false);
});

test("bootstrap is idempotent and safe to run repeatedly", async () => {
  // The data layer caches one connection for the process, so this runs against
  // the database the previous test bootstrapped: exactly the "second process"
  // case, without pretending a new path reopens the connection.
  const { bootstrapDatabase, counts } = await import("../lib/seed");
  const { get } = await import("../lib/db");

  const activities = counts().activities;
  assert.ok(activities > 0, "the first bootstrap seeded activities");

  const again = bootstrapDatabase();
  assert.equal(again.createdDemo, false);
  assert.equal(counts().activities, activities, "no duplicate activities");

  const proposals = get<{ n: number }>(`SELECT COUNT(*) AS n FROM enhancements`);
  assert.equal(Number(proposals?.n), 3, "2 seeded proposals + the imported one, each exactly once");
});
