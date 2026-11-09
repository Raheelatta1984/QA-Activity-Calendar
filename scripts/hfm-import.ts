import fs from "node:fs";
import path from "node:path";
import { getDb, migrate, dbFile, backup } from "../lib/db";
import { runHfmImport, rollbackHfmImport, verifyHfmImport, EXPECTED_COUNTS } from "../lib/hfm-import";

/**
 * HFM seed/import CLI.
 *
 *   tsx scripts/hfm-import.ts                # dry-run (default, writes nothing)
 *   tsx scripts/hfm-import.ts --apply        # apply in a single transaction (backup first)
 *   tsx scripts/hfm-import.ts --apply --no-backup   # skip the automatic backup (not recommended)
 *   tsx scripts/hfm-import.ts --verify       # read-only acceptance checks
 *   tsx scripts/hfm-import.ts --rollback <import_batch_id> [--actor "Name"]
 *
 * Options:
 *   --actor "Display Name"  Record this person as the executing actor (an authorised session).
 *                           Without --actor the executor is recorded as the service migration.
 *   --requested-by "Name"   Override the requested_by value (default: Raheel Atta).
 *   --report <file.json>    Write the full JSON report to a file as well as stdout.
 *   --json                  Print only the machine-readable JSON report.
 *
 * Never runs against production unless you point DATABASE_FILE/DATABASE at it —
 * and even then, only after owner approval. The importer performs no DELETEs
 * except inside --rollback, and never touches demo tenants or non-HFM records.
 */

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function main() {
  const db = getDb();
  migrate(db);
  const jsonOnly = has("--json");
  const reportPath = arg("--report");
  const actorName = arg("--actor") ?? null;
  const requestedBy = arg("--requested-by") ?? "Raheel Atta";

  if (has("--verify")) {
    const result = verifyHfmImport();
    printVerification(result, jsonOnly);
    process.exitCode = result.failed === 0 ? 0 : 1;
    return finish(result, reportPath, jsonOnly);
  }

  const rollbackId = arg("--rollback");
  if (rollbackId) {
    const result = rollbackHfmImport(rollbackId, actorName ?? "operator");
    console.log(jsonOnly ? JSON.stringify(result, null, 2) : [
      `Rollback of batch ${result.batchId} complete:`,
      `  activities deleted:  ${result.deleted.activities}`,
      `  pipeline deleted:    ${result.deleted.pipeline}`,
      `  exclusions deleted:  ${result.deleted.exclusions}`,
      ...result.notes.map((n) => `  note: ${n}`),
    ].join("\n"));
    return finish(result, reportPath, jsonOnly);
  }

  const apply = has("--apply");
  let backupPath: string | null = null;
  if (apply && !has("--no-backup")) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(process.cwd(), "data", "backups");
    fs.mkdirSync(dir, { recursive: true });
    backupPath = path.join(dir, `qa-calendar-pre-hfm-import-${stamp}.db`);
    await backup(db, backupPath);
    if (!jsonOnly) console.log(`Pre-import backup written to ${backupPath}`);
  }

  const report = runHfmImport({ apply, actorId: null, actorName, requestedBy, backupPath });

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  if (report.errors.length) process.exitCode = 1;
  finish(report, reportPath, jsonOnly);
}

function finish(report: unknown, reportPath: string | undefined, jsonOnly: boolean) {
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (!jsonOnly) console.log(`Report written to ${reportPath}`);
  }
}

function printVerification(result: ReturnType<typeof verifyHfmImport>, jsonOnly: boolean) {
  if (jsonOnly) return;
  console.log("HFM import verification (read-only)\n==================================");
  for (const check of result.checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
  }
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
}

function printReport(report: ReturnType<typeof runHfmImport>) {
  const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${value}`);
  console.log(`HFM import — ${report.mode.toUpperCase()} (${report.startedAt})`);
  console.log(`Database: ${dbFile}`);
  console.log(`Requested by: ${report.requestedBy}   Executor: ${report.executor}`);
  if (report.backupPath) console.log(`Backup: ${report.backupPath}`);
  console.log("\nOrganisation:");
  for (const action of (report.organisation as any).actions ?? []) console.log(`  - ${action}`);
  const section = (name: string, c: { inserted: number; updated: number; unchanged: number; skipped: number }) => {
    console.log(`\n${name}: inserted=${c.inserted} updated=${c.updated} unchanged=${c.unchanged} skipped=${c.skipped}`);
  };
  section("Master activities (tblActivities)", report.activities);
  section("Pending pipeline (tblRecordingPipeline)", report.pipeline);
  section("Manual exclusions (tblPipelineExclusions)", report.exclusions);
  console.log("\nStored counts:");
  line("master activities", `${report.counts.master.total} (${report.counts.master.active} active / ${report.counts.master.inactive} inactive)`);
  line("pending pipeline", report.counts.pipeline);
  line("manual exclusions", report.counts.exclusions);
  console.log("\nExpected counts (source snapshot):", JSON.stringify(report.expected));
  if (report.unresolvedAssignees.length) {
    console.log(`\nUnresolved source assignees (kept UNASSIGNED, on the review list): ${report.unresolvedAssignees.join(", ")}`);
  }
  if (report.conflicts.length) {
    console.log(`\nConflicts / portal-edit collisions (${report.conflicts.length}):`);
    for (const conflict of report.conflicts.slice(0, 40)) {
      console.log(`  - ${conflict.entity} ${conflict.id ?? ""} · ${conflict.field}: source=${JSON.stringify(conflict.source)} portal=${JSON.stringify(conflict.current)}`);
    }
    if (report.conflicts.length > 40) console.log(`  … and ${report.conflicts.length - 40} more (see --report)`);
  }
  if (report.warnings.length) {
    console.log(`\nWarnings (${report.warnings.length}):`);
    for (const warning of report.warnings.slice(0, 60)) console.log(`  - ${warning}`);
    if (report.warnings.length > 60) console.log(`  … and ${report.warnings.length - 60} more (see --report)`);
  }
  if (report.errors.length) {
    console.log(`\nERRORS:`);
    for (const error of report.errors) console.log(`  ! ${error}`);
  } else {
    console.log("\nNo errors. " + (report.mode === "dry-run" ? "Re-run with --apply to write." : "Import committed."));
  }
}

main().catch((error) => {
  console.error(`HFM import failed: ${error?.stack ?? error}`);
  process.exit(1);
});
