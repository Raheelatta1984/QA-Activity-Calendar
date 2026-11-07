import fs from "node:fs";
import path from "node:path";
import { pipelineStages, type EnhancementStatus } from "./enhancement-status";

/**
 * Repository handover documents (`lib/future-enhancements/ENH-*.md`).
 *
 * These files are the durable record of an approved enhancement. The app cannot
 * commit them (a serverless deployment has a read-only bundle), so instead it
 * *reconciles* its database against them: when the completion automation has
 * moved a file into `archived/`, the matching in-app request follows it to
 * `Archived`. That is what makes "move the file to the archive, then update the
 * status" a truthful statement rather than a manual step somebody has to
 * remember.
 *
 * Everything here is read-only or best-effort. A read-only filesystem, a missing
 * database or a malformed frontmatter block must never break a page render.
 */

export const ACTIVE_HANDOVER_DIR = "lib/future-enhancements";
export const ARCHIVED_HANDOVER_DIR = "lib/future-enhancements/archived";
export const LEGACY_ARCHIVED_HANDOVER_DIR = "lib/future-enhancements/archive";
export const HANDOVER_NAME_RE = /^ENH-[0-9]+-[a-z0-9-]+\.md$/;
/** Default place for the deploy-time reconciliation report (gitignored). */
export const DEFAULT_SYNC_REPORT = ".tmp/enhancement-docs-sync.md";

export type HandoverDoc = {
  /** File name, e.g. `ENH-0004-welcome-note.md`. */
  name: string;
  /** Path from the repository root. */
  relativePath: string;
  status: EnhancementStatus | string;
  ref: string | null;
  title: string | null;
  archived: boolean;
};

function parseFrontmatter(text: string): Record<string, string> | null {
  const content = String(text ?? "");
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*"?([^"]*)"?\s*$/i);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/** Read ref/title/status out of a handover document. Never throws. */
export function readHandoverDoc(content: string, name = "ENH-0000-document.md", archived = false): HandoverDoc | null {
  const meta = parseFrontmatter(content);
  if (!meta) return null;
  const status = meta.status ?? "Unknown";
  return {
    name,
    relativePath: archived
      ? `${ARCHIVED_HANDOVER_DIR}/${name}`
      : `${ACTIVE_HANDOVER_DIR}/${name}`,
    status,
    ref: meta.ref ?? null,
    title: meta.title ?? null,
    archived,
  };
}

function readDir(dir: string, archived: boolean): HandoverDoc[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && HANDOVER_NAME_RE.test(entry.name))
      .map((entry) => {
        try {
          return readHandoverDoc(fs.readFileSync(path.join(dir, entry.name), "utf8"), entry.name, archived);
        } catch {
          return null;
        }
      })
      .filter((doc): doc is HandoverDoc => Boolean(doc));
  } catch {
    return [];
  }
}

/** Active and archived handovers found in this checkout (usually empty on Vercel). */
export function scanHandoverDocs(root = process.cwd()): { active: HandoverDoc[]; archived: HandoverDoc[] } {
  const active = readDir(path.join(root, ACTIVE_HANDOVER_DIR), false);
  const archived = [
    ...readDir(path.join(root, ARCHIVED_HANDOVER_DIR), true),
    ...readDir(path.join(root, LEGACY_ARCHIVED_HANDOVER_DIR), true),
  ];
  const seen = new Set<string>();
  return {
    active: active.filter((doc) => (seen.has(doc.name) ? false : seen.add(doc.name))),
    archived: archived.filter((doc) => (seen.has(doc.name) ? false : seen.add(doc.name))),
  };
}

export type HandoverSyncChange = {
  id: string;
  ref: string;
  title: string;
  from: string;
  to: EnhancementStatus;
  reason: "archived-file" | "built-file" | "linked-file";
  source: string;
};

export type EnhancementRecordRef = {
  id: string;
  ref: string;
  title: string;
  status: string;
  github_path: string | null;
};

type RecordIndex = {
  byPathName: Map<string, EnhancementRecordRef>;
  byRef: Map<string, EnhancementRecordRef[]>;
};

export function indexEnhancementRecords(records: EnhancementRecordRef[]): RecordIndex {
  const byPathName = new Map<string, EnhancementRecordRef>();
  const byRef = new Map<string, EnhancementRecordRef[]>();
  for (const record of records) {
    if (record.github_path) byPathName.set(path.basename(record.github_path), record);
    byRef.set(record.ref, [...(byRef.get(record.ref) ?? []), record]);
  }
  return { byPathName, byRef };
}

/**
 * Which in-app request a handover document belongs to.
 *
 * Exact file-name match first, then a unique ref. Two handovers can share a ref
 * (proposals created on ephemeral instances both start at ENH-0004), so an
 * ambiguous ref is never guessed at — it is reported as unlinked instead.
 */
export function matchEnhancementRecord(
  doc: HandoverDoc,
  index: RecordIndex
): EnhancementRecordRef | null {
  const exact = index.byPathName.get(doc.name);
  if (exact) return exact;
  const candidates = index.byRef.get(doc.ref ?? "") ?? [];
  if (candidates.length === 1) return candidates[0];
  const unlinked = candidates.filter((record) => !record.github_path);
  return unlinked.length === 1 ? unlinked[0] : null;
}

/** Convenience wrapper for callers that have not built an index yet. */
export function matchHandoverDoc(doc: HandoverDoc, records: EnhancementRecordRef[]): EnhancementRecordRef | null {
  return matchEnhancementRecord(doc, indexEnhancementRecords(records));
}

type SyncOptions = {
  root?: string;
  /** `false` reports what would change without writing (used by tests/CLI). */
  apply?: boolean;
};

/**
 * Reconcile enhancement records with the handover documents in this checkout.
 *
 * - an archived document means the implementation shipped and the handover was
 *   archived, so the request becomes `Archived` (never overwriting `Rejected`);
 * - a `Built` document means the build exists but the archive move is still
 *   pending, so a `Building` request becomes `Built`;
 * - an unlinked record whose file name matches is re-pointed at the document so
 *   downloads keep working after a move.
 */
export async function syncEnhancementDocs({ root = process.cwd(), apply = true }: SyncOptions = {}): Promise<{
  changes: HandoverSyncChange[];
  scanned: { active: number; archived: number };
}> {
  const { active, archived } = scanHandoverDocs(root);
  const changes: HandoverSyncChange[] = [];
  if (!active.length && !archived.length) return { changes, scanned: { active: 0, archived: 0 } };

  const { all, run } = await import("./db");
  const records = all<EnhancementRecordRef>(
    `SELECT id, ref, title, status, github_path FROM enhancements`
  );
  const index = indexEnhancementRecords(records);
  const matchFor = (doc: HandoverDoc) => matchEnhancementRecord(doc, index);

  for (const doc of [...archived, ...active]) {
    const record = matchFor(doc);
    if (!record) continue;

    if (doc.archived && record.status !== "Archived" && record.status !== "Rejected") {
      changes.push({
        id: record.id,
        ref: record.ref,
        title: record.title,
        from: record.status,
        to: "Archived",
        reason: "archived-file",
        source: doc.relativePath,
      });
      if (apply) {
        run(
          `UPDATE enhancements
              SET status = 'Archived', archived_at = COALESCE(archived_at, datetime('now')),
                  github_path = ?, updated_at = datetime('now')
            WHERE id = ?`,
          doc.relativePath,
          record.id
        );
      }
      continue;
    }

    // A Built document proves the implementation exists, so any earlier stage is
    // promoted rather than left claiming the work has not been delivered.
    const stages = pipelineStages();
    const builtRank = stages.indexOf("Built");
    const recordRank = stages.indexOf(record.status as EnhancementStatus);
    if (!doc.archived && doc.status === "Built" && recordRank >= 0 && recordRank < builtRank) {
      changes.push({
        id: record.id,
        ref: record.ref,
        title: record.title,
        from: record.status,
        to: "Built",
        reason: "built-file",
        source: doc.relativePath,
      });
      if (apply) {
        run(
          `UPDATE enhancements SET status = 'Built', github_path = ?, updated_at = datetime('now') WHERE id = ?`,
          doc.relativePath,
          record.id
        );
      }
      continue;
    }

    // The document moved (for example into archived/): keep the stored path
    // pointing at the file that actually exists so downloads stay accurate.
    const stored = record.github_path ?? "";
    if (stored && path.basename(stored) === doc.name && stored !== doc.relativePath) {
      changes.push({
        id: record.id,
        ref: record.ref,
        title: record.title,
        from: record.status,
        to: record.status as EnhancementStatus,
        reason: "linked-file",
        source: doc.relativePath,
      });
      if (apply) {
        run(`UPDATE enhancements SET github_path = ?, updated_at = datetime('now') WHERE id = ?`, doc.relativePath, record.id);
      }
    }
  }

  return { changes, scanned: { active: active.length, archived: archived.length } };
}

export function syncReportPath(): string {
  const configured = process.env.ENHANCEMENT_SYNC_REPORT?.trim();
  if (!configured) return path.join(process.cwd(), DEFAULT_SYNC_REPORT);
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

/** Write a small Markdown report so a deploy log shows what the sync changed. */
export function writeSyncReport(result: { changes: HandoverSyncChange[]; scanned: { active: number; archived: number } }): string | null {
  const target = syncReportPath();
  const lines = [
    "# Enhancement document sync",
    "",
    `Scanned ${result.scanned.active} active and ${result.scanned.archived} archived handover document(s).`,
    "",
    result.changes.length
      ? `## Status updates (${result.changes.length})`
      : "No status updates were required.",
    ...result.changes.map(
      (change) =>
        `- ${change.ref} — ${change.from} → ${change.to} (${change.reason.replace("-", " ")}: \`${change.source}\`)`
    ),
    "",
  ];
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.join("\n"), "utf8");
    return target;
  } catch {
    return null;
  }
}

/**
 * Deploy-time reconciliation used by the completion workflow and `npm run
 * enhancement:sync`. Safe on any filesystem: a read-only vault or a missing
 * database is reported as "skipped" rather than failing a deployment.
 */
export async function runDeploySync(env: NodeJS.ProcessEnv = process.env): Promise<{
  status: "skipped" | "applied";
  reason?: string;
  scanned?: { active: number; archived: number };
  changes?: HandoverSyncChange[];
  report?: string | null;
}> {
  if (String(env.ENHANCEMENT_DOC_SYNC ?? "").toLowerCase() === "false") {
    return { status: "skipped", reason: "ENHANCEMENT_DOC_SYNC is false" };
  }
  const timeout = Number(env.ENHANCEMENT_DOC_SYNC_TIMEOUT_MS ?? 2000);
  const scanned = scanHandoverDocs(process.cwd());
  if (!scanned.active.length && !scanned.archived.length) {
    // Nothing committed in this build (the usual serverless case): do not touch
    // the database or the temp directory at all.
    return { status: "skipped", reason: "no handover documents in this build" };
  }
  const work = (async () => {
    const result = await syncEnhancementDocs({ root: process.cwd(), apply: true });
    const report = writeSyncReport(result);
    return { status: "applied" as const, scanned: result.scanned, changes: result.changes, report };
  })();
  const capped = new Promise<{ status: "skipped"; reason: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "skipped", reason: `timed out after ${timeout}ms` }), Math.max(200, timeout));
    timer.unref?.();
  });
  try {
    return await Promise.race([work, capped]);
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function handoverDocsWritable(root = process.cwd()): boolean {
  try {
    fs.accessSync(path.join(root, ACTIVE_HANDOVER_DIR), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
