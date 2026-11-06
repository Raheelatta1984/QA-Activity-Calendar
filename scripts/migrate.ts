import { getDb, migrate, dbFile } from "../lib/db";

const db = getDb();
const applied = migrate(db);
console.log(`Database: ${dbFile}`);
console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(", ")}` : "No pending migrations.");
