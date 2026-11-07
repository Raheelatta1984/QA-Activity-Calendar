/**
 * `npm run enhancement:sync`
 *
 * Reconciles this instance's enhancement statuses with the handover documents in
 * `lib/future-enhancements/`. Run it after pulling a branch that contains a
 * completed handover, or in a deployment that bundles the documents.
 *
 * Pass `--dry-run` to see what would change without writing.
 */
const apply = !process.argv.includes("--dry-run");

async function main() {
  const { syncEnhancementDocs, scanHandoverDocs, writeSyncReport } = await import("../lib/enhancement-docs");
  const { changes, scanned } = await syncEnhancementDocs({ root: process.cwd(), apply });
  console.log(
    `${apply ? "Synced" : "Would sync"} ${scanned.active} active and ${scanned.archived} archived handover document(s).`
  );
  if (!changes.length) console.log("Every enhancement already matches its document.");
  for (const change of changes) {
    console.log(
      change.reason === "linked-file"
        ? `${change.ref}: linked to ${change.source}`
        : `${change.ref}: ${change.from} → ${change.to} (${change.reason}, ${change.source})`
    );
  }
  if (apply) {
    const report = writeSyncReport({ changes, scanned });
    if (report) console.log(`Report: ${report}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
