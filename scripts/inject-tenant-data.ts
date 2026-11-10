/**
 * Copy HFM operational data into the separate Harrisfarm Markets tenant.
 *
 *   npm run db:inject-tenant                 # dry-run preview only
 *   npm run db:inject-tenant -- --apply      # copy (requires --confirm COPY)
 *   npm run db:inject-tenant -- --delete <batch-id> --confirm DELETE
 *
 * The copy is tagged and reversible; the source tenant is never modified.
 */
import { initDb, migrate } from "../lib/db";
import {
  defaultSourceCompanyId,
  defaultTargetCompanyId,
  deleteTenantInjection,
  injectTenantData,
  listInjectionBatches,
  previewTenantInjection,
} from "../lib/tenant-injection";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

initDb();
migrate();
const source = arg("--source") ?? defaultSourceCompanyId();
const target = arg("--target") ?? defaultTargetCompanyId();
if (!source || !target) {
  console.error("Could not resolve source and target tenants. Pass --source <id> --target <id>.");
  process.exit(1);
}
const actorName = arg("--actor") ?? "tenant-injection-cli";
const confirmation = arg("--confirm");

const deleteBatch = arg("--delete");
if (deleteBatch) {
  if (confirmation !== "DELETE") {
    console.error("Refusing to delete without --confirm DELETE. This only removes tagged target copies.");
    process.exit(1);
  }
  const result = deleteTenantInjection({ batchId: deleteBatch, targetCompanyId: target, actorName });
  console.log(`Deleted copy batch ${result.batch.id}: ${JSON.stringify(result.deleted)}`);
  process.exit(0);
}

const preview = previewTenantInjection({ sourceCompanyId: source, targetCompanyId: target });
console.log(`Source ${preview.source?.name} (${source})`);
console.log(`Target ${preview.target?.name} (${target})`);
for (const table of preview.tables) console.log(`  ${table.label.padEnd(32)} ${table.count}`);
if (preview.activeBatch) {
  console.log(`Active batch ${preview.activeBatch.id} already exists; re-running is a no-op.`);
}
if (!has("--apply")) {
  console.log("Dry-run only. Re-run with --apply --confirm COPY to copy.");
  process.exit(0);
}
if (confirmation !== "COPY") {
  console.error("Refusing to copy without --confirm COPY.");
  process.exit(1);
}
const result = injectTenantData({ sourceCompanyId: source, targetCompanyId: target, actorName });
console.log(
  result.reused
    ? `Active batch ${result.batch.id} already exists; nothing written.`
    : `Copied into batch ${result.batch.id}: ${JSON.stringify(result.counts)}`
);
for (const batch of listInjectionBatches(target)) {
  console.log(` - ${batch.id} ${batch.status} ${batch.created_at} ${JSON.stringify(batch.counts)}`);
}
