import { initDb } from "../lib/db";
import { bootstrapDatabase, counts } from "../lib/seed";
import { runValidation } from "../lib/validation";

initDb();
const result = bootstrapDatabase();
runValidation();
const summary = counts();
console.log(
  `Seed ${result.createdReference || result.createdDemo ? "applied" : "skipped (data already present)"} — ` +
    `${summary.people} people, ${summary.activities} activities, ${summary.pipeline} pipeline rows, ${summary.bugs} bugs, ` +
    `${(summary.tabs as unknown[]).length} tabs.`
);
