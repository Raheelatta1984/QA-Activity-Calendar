/**
 * Online backup using SQLite's backup API, then report size + checksum.
 *   npm run db:backup -- ./data/backups
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { backup, getDb, dbFile } from "../lib/db";

async function main() {
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

main();
