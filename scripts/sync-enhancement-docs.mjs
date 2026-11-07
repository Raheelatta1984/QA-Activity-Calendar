import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SYNC_REPORT,
  scanHandoverDocs,
  syncEnhancementDocs,
  writeSyncReport,
} from "../lib/enhancement-docs";

/**
 * Reconcile the in-app enhancement statuses with the handover documents.
 *
 * The completion workflow archives the Markdown *in Git*. The deployed app keeps
 * its status in the database, so the two only agree if something reads the files
 * and writes the status. That is this script: it runs from the workflow (against
 * the freshly archived main checkout), from a workstation (`npm run
 * enhancement:sync`) and automatically on bootstrap when the deployment bundles
 * the documents.
 *
 * A read-only or missing database is not an error: the script reports what it
 * found and exits successfully so an archive commit is never blocked by an
 * application database.
 */
export async function runDocSync(env = process.env, { root = process.cwd(), apply = true } = {}) {
  const docs = scanHandoverDocs(root);
  const summary = [];
  const scanned = { active: docs.active.length, archived: docs.archived.length };
  if (!scanned.active && !scanned.archived) {
    summary.push("No handover documents in this checkout; nothing to reconcile.");
    return { status: "no-documents", scanned, changes: [], summary };
  }

  let result;
  try {
    result = await syncEnhancementDocs({ root, apply });
  } catch (error) {
    // The database may be absent in CI or on a read-only bundle. Report and move on.
    summary.push(`Skipped database reconciliation: ${error instanceof Error ? error.message : String(error)}`);
    const report = writeSyncReport({ changes: [], scanned });
    return { status: "skipped", scanned, changes: [], summary, report };
  }

  for (const change of result.changes) {
    summary.push(
      change.reason === "linked-file"
        ? `${change.ref}: linked to ${change.source}`
        : `${change.ref}: ${change.from} → ${change.to} (${change.source})`
    );
  }
  if (!result.changes.length) summary.push("Every request already matches its document.");
  const report = writeSyncReport(result);
  if (report) summary.push(`Report: ${path.relative(process.cwd(), report) || DEFAULT_SYNC_REPORT}`);
  return { status: apply ? "applied" : "planned", scanned, changes: result.changes, summary, report };
}

async function appendSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(file, `### Enhancement document sync\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDocSync(process.env, { apply: process.argv.includes("--apply") || Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS) })
    .then(async (result) => {
      for (const line of result.summary) console.log(line);
      await appendSummary(result.summary);
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}
