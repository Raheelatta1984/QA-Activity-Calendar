/**
 * `npm run sync` — reconcile hub statuses with the vault documents.
 *
 * Ported from the source project's scripts/sync-docs-cli.ts. Pass --tenant /
 * --application to narrow the scope, --dry-run to preview.
 */
const applyFlag = !process.argv.includes("--dry-run");
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const { syncVaultDocs } = await import("../server/core/service.ts");
  const { ensureTenant } = await import("../server/core/service.ts");
  // Booting the data layer requires the schema; ensureTenant("default") is an
  // idempotent no-op that guarantees it exists before reconciliation reads.
  ensureTenant(flag("--tenant") || process.env.HUB_DEFAULT_TENANT || "default");
  const { changes, scanned } = syncVaultDocs(
    { name: "cli", role: "editor" },
    {
      tenantSlug: flag("--tenant"),
      applicationSlug: flag("--application"),
      apply: applyFlag,
    }
  );
  console.log(
    `${applyFlag ? "Synced" : "Would sync"} ${scanned.active} active and ${scanned.archived} archived handover document(s).`
  );
  if (!changes.length) console.log("Every enhancement already matches its document.");
  for (const change of changes) {
    console.log(
      change.reason === "linked-file"
        ? `${change.ref}: linked to ${change.source}`
        : `${change.ref}: ${change.from} → ${change.to} (${change.reason}, ${change.source})`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
