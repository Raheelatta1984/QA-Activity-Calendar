import { dbInfo, initDb, migrate } from "../lib/db";

initDb();
const applied = migrate();
const info = dbInfo();
console.log(`Database (${info.driver}): ${info.target}`);
console.log(
  applied.length ? `Applied ${applied.length} migration(s): ${applied.join(", ")}` : "No pending migrations."
);
