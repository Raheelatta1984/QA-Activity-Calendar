/**
 * DESTRUCTIVE: removes the local SQLite database file and rebuilds it from
 * migrations + demo seed. Never run against a shared or production database.
 */
import fs from "node:fs";
import { dbFile, dbInfo } from "../lib/db";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset the database when NODE_ENV=production.");
  process.exit(1);
}
if (dbInfo().driver === "postgres") {
  console.error(
    "Refusing to reset a Postgres database. Drop/recreate the schema with your database provider, " +
      "or set DATABASE_URL= (empty) to reset the local SQLite file instead."
  );
  process.exit(1);
}
for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbFile}${suffix}`;
  if (fs.existsSync(target)) fs.rmSync(target);
}
console.log(`Removed ${dbFile}. Run npm run db:seed to rebuild.`);
