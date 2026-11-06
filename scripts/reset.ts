/**
 * DESTRUCTIVE: removes the local database file and rebuilds it from migrations
 * + demo seed. Never run against a shared or production database.
 */
import fs from "node:fs";
import { dbFile } from "../lib/db";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset the database when NODE_ENV=production.");
  process.exit(1);
}
for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbFile}${suffix}`;
  if (fs.existsSync(target)) fs.rmSync(target);
}
console.log(`Removed ${dbFile}. Run npm run db:seed to rebuild.`);
