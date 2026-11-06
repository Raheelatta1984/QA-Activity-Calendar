/**
 * Import CLI — dry run by default.
 *
 *   npm run import -- data/sample-activities.csv --target activities
 *   npm run import -- data/sample-activities.csv --target activities --apply
 *
 * Never touches the source workbook; writes only to the application database.
 */
import fs from "node:fs";
import path from "node:path";
import { get, getDb } from "../lib/db";
import { runImport, type ImportMode, type ImportTarget } from "../lib/import";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: npm run import -- <file.csv> [--target activities|pipeline] [--apply] [--sheet tblActivities]");
  process.exit(1);
}
const fullPath = path.resolve(process.cwd(), file);
if (!fs.existsSync(fullPath)) {
  console.error(`File not found: ${fullPath}`);
  process.exit(1);
}

const target = (arg("target", "activities") as ImportTarget) ?? "activities";
const mode: ImportMode = process.argv.includes("--apply") ? "apply" : "dry-run";
const sheet = arg("sheet");
const actor = get<{ id: string }>(`SELECT id FROM people WHERE role = 'admin' ORDER BY name LIMIT 1`);

getDb();
const text = fs.readFileSync(fullPath, "utf8");
const report = runImport({
  text,
  target,
  mode,
  filename: path.basename(file),
  sheet,
  actorId: actor?.id ?? null,
});

console.log(`\nImport ${mode.toUpperCase()} → ${target}`);
console.log(`Batch ${report.batchId}`);
console.table({
  rows: report.total,
  inserted: report.inserted,
  updated: report.updated,
  skipped: report.skipped,
  errors: report.errors,
});

if (report.warnings.length) {
  console.log("\nWarnings:");
  for (const warning of report.warnings) console.log(` - ${warning}`);
}
if (report.rows.length) {
  console.log("\nRow disposition (first 25):");
  console.table(report.rows.slice(0, 25));
}
if (report.errors) {
  console.error("\nCompleted with errors — nothing was silently corrected. Review the rows above.");
  process.exitCode = 2;
} else if (mode === "dry-run") {
  console.log("\nDry run only. Re-run with --apply to write the records.");
}
