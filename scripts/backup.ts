/**
 * Online backup using SQLite's backup API, then report size + checksum.
 *   npm run db:backup -- ./data/backups
 *
 * On Postgres this command explains the managed alternative instead of writing
 * a SQLite file that does not contain the live data.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { backup, dbFile, dbInfo, getDb } from "../lib/db";

async function main() {
  const info = dbInfo();
  if (info.driver === "postgres") {
    console.log(
      `The active store is Postgres (${info.target}). Take backups with pg_dump or your provider's managed backups:\n` +
        "  pg_dump \"$DATABASE_URL\" --no-owner --format=custom --file=qa-calendar.dump"
    );
    return;
  }
  const dir = path.resolve(process.cwd(), process.argv[2] ?? "data/backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `qa-calendar-${stamp}.db`);
  await backup(getDb(), target);
  const buffer = fs.readFileSync(target);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  fs.writeFileSync(`${target}.sha256`, `${checksum}  ${path.basename(target)}\n`);
  console.log(`Backed up ${dbFile} → ${target}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB · SHA-256 ${checksum}`);
}

main().catch((error) => {
  console.error(`backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
