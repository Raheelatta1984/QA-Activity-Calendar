/**
 * Vault — the Markdown record of handovers, ported from the source app's
 * `lib/enhancements.ts` (write/relocate/remove half) and
 * `lib/enhancement-docs.ts` (scan/match/sync half), generalised for tenancy.
 *
 * Layout under the vault root (default ./vault, override with HUB_VAULT_DIR):
 *
 *   <tenant>/<application>/ENH-0001-title.md          active handovers
 *   <tenant>/<application>/archived/ENH-0001-...md    completed records
 *   <tenant>/<application>/archive/ENH-0001-...md     legacy alias, also read
 *
 * Serverless/read-only filesystems transparently fall back to a temp directory
 * so a cold start never depends on writable storage. Everything here is
 * best-effort: an unwritable vault degrades to "database only" instead of
 * failing a request.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipelineStages, statusAfterArchive, type EnhancementStatus } from "./status.ts";
import { enhancementFileName, handoverFileName, parseFrontmatter, updateFrontmatterStatus } from "./markdown.ts";

export const HANDOVER_NAME_RE = /^ENH-[0-9]+-[a-z0-9-]+\.md$/i;

const TMP_VAULT = path.join(os.tmpdir(), "enhancements-hub-vault");
const unwritableDirs = new Set<string>();

function isServerlessRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.CF_PAGES
  );
}

function isDirWritable(targetDir: string): boolean {
  if (unwritableDirs.has(targetDir)) return false;
  try {
    let probe = path.resolve(targetDir);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function vaultRoot(): string {
  const configured = process.env.HUB_VAULT_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (isServerlessRuntime()) return TMP_VAULT;
  return path.join(process.cwd(), "vault");
}

export function vaultInfo(): { dir: string; ephemeral: boolean; serverless: boolean } {
  const serverless = isServerlessRuntime();
  const preferred = vaultRoot();
  if (isDirWritable(preferred)) {
    const inTmp = preferred === TMP_VAULT || preferred.startsWith(`${os.tmpdir()}${path.sep}`);
    return { dir: preferred, ephemeral: serverless || inTmp, serverless };
  }
  return { dir: TMP_VAULT, ephemeral: true, serverless };
}

/** `<tenant>/<application>` pair, sanitised against path traversal. */
function scopeDir(tenantSlug: string, applicationSlug: string): string {
  const safeTenant = tenantSlug.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
  const safeApp = applicationSlug.replace(/[^a-zA-Z0-9_-]+/g, "-") || "general";
  return path.join(vaultRoot(), safeTenant, safeApp);
}

function writeIntoDir(baseDir: string, safeName: string, content: string, archived: boolean): string {
  const targetDir = archived ? path.join(baseDir, "archived") : baseDir;
  fs.mkdirSync(targetDir, { recursive: true });
  const fullPath = path.join(targetDir, safeName);
  fs.writeFileSync(fullPath, content, "utf8");
  // Keep exactly one copy: writing to the archive removes the active file and vice versa.
  const counterpart = archived ? path.join(baseDir, safeName) : path.join(baseDir, "archived", safeName);
  try {
    if (fs.existsSync(counterpart)) fs.unlinkSync(counterpart);
    const legacy = archived ? path.join(baseDir, safeName) : path.join(baseDir, "archive", safeName);
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {
    /* counterpart cleanup is best-effort */
  }
  return fullPath;
}

export type VaultWriteResult = {
  relativePath: string;
  fullPath: string | null;
  ephemeral: boolean;
  persistedToDisk: boolean;
};

export function writeVaultMarkdown(options: {
  tenantSlug: string;
  applicationSlug: string;
  fileName: string;
  content: string;
  archived?: boolean;
  previousPath?: string | null;
}): VaultWriteResult {
  const safeName = path.basename(options.fileName);
  const archived = Boolean(options.archived);
  const relativePath = `${options.tenantSlug}/${options.applicationSlug}/${archived ? "archived/" : ""}${safeName}`;
  const preferred = scopeDir(options.tenantSlug, options.applicationSlug);
  const serverless = isServerlessRuntime();

  const cleanupOldFile = (baseDir: string) => {
    if (!options.previousPath) return;
    const oldName = path.basename(options.previousPath);
    if (!oldName || oldName === safeName) return;
    for (const candidate of [path.join(baseDir, oldName), path.join(baseDir, "archived", oldName), path.join(baseDir, "archive", oldName)]) {
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* best-effort cleanup */
      }
    }
  };

  if (!unwritableDirs.has(preferred)) {
    try {
      const fullPath = writeIntoDir(preferred, safeName, options.content, archived);
      cleanupOldFile(preferred);
      const inTmp = preferred.startsWith(`${os.tmpdir()}${path.sep}`);
      return { relativePath, fullPath, ephemeral: serverless || inTmp, persistedToDisk: true };
    } catch (error) {
      unwritableDirs.add(preferred);
      console.warn(`[hub] vault ${preferred} is not writable (${(error as Error).message}); falling back to ${TMP_VAULT}.`);
    }
  }

  const fallbackDir = path.join(TMP_VAULT, options.tenantSlug, options.applicationSlug);
  if (fallbackDir !== preferred) {
    try {
      const fullPath = writeIntoDir(fallbackDir, safeName, options.content, archived);
      cleanupOldFile(fallbackDir);
      return { relativePath, fullPath, ephemeral: true, persistedToDisk: true };
    } catch (fallbackError) {
      console.warn(
        `[hub] fallback vault ${fallbackDir} is also not writable (${(fallbackError as Error).message}); keeping the record in the database only.`
      );
    }
  }

  return { relativePath, fullPath: null, ephemeral: true, persistedToDisk: false };
}

function candidateDirs(tenantSlug: string, applicationSlug: string): string[] {
  const preferred = scopeDir(tenantSlug, applicationSlug);
  const fallback = path.join(TMP_VAULT, tenantSlug, applicationSlug);
  const dirs = preferred === fallback ? [preferred] : [preferred, fallback];
  return dirs.filter((dir) => !unwritableDirs.has(dir));
}

function findExistingVaultFile(tenantSlug: string, applicationSlug: string, safeName: string): string | null {
  for (const dir of candidateDirs(tenantSlug, applicationSlug)) {
    for (const candidate of [path.join(dir, safeName), path.join(dir, "archived", safeName), path.join(dir, "archive", safeName)]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore unreadable paths */
      }
    }
  }
  return null;
}

export function relocateVaultMarkdown(options: {
  tenantSlug: string;
  applicationSlug: string;
  githubPath: string | null;
  ref: string;
  title: string;
  status: string;
  fallbackContent: string;
}): VaultWriteResult {
  const safeName = options.githubPath
    ? path.basename(options.githubPath)
    : enhancementFileName(options.ref, options.title);
  const existingPath = findExistingVaultFile(options.tenantSlug, options.applicationSlug, safeName);
  let content = options.fallbackContent;
  if (existingPath) {
    try {
      content = updateFrontmatterStatus(fs.readFileSync(existingPath, "utf8"), options.status);
    } catch {
      /* fall back to synthesised markdown */
    }
  }
  return writeVaultMarkdown({
    tenantSlug: options.tenantSlug,
    applicationSlug: options.applicationSlug,
    fileName: safeName,
    content,
    archived: options.status === "Archived",
  });
}

export function removeVaultMarkdown(tenantSlug: string, applicationSlug: string, githubPath: string | null): void {
  if (!githubPath) return;
  const safeName = path.basename(githubPath);
  if (!safeName) return;
  for (const dir of candidateDirs(tenantSlug, applicationSlug)) {
    for (const candidate of [path.join(dir, safeName), path.join(dir, "archived", safeName), path.join(dir, "archive", safeName)]) {
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* file cleanup is best-effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handover documents — scan, parse, match, reconcile
// ---------------------------------------------------------------------------

export type HandoverDoc = {
  name: string;
  /** `<tenant>/<application>[/archived]/<name>` as stored in enhancements.github_path. */
  relativePath: string;
  status: string;
  ref: string | null;
  title: string | null;
  archived: boolean;
};

function readHandoverDoc(content: string, name: string, relativePath: string, archived: boolean): HandoverDoc | null {
  const meta = parseFrontmatter(content);
  if (!meta) return null;
  return {
    name,
    relativePath,
    status: meta.status ?? "Unknown",
    ref: meta.ref ?? null,
    title: meta.title ?? null,
    archived,
  };
}

function readDir(dir: string, prefix: string, archived: boolean): HandoverDoc[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && HANDOVER_NAME_RE.test(entry.name))
      .map((entry) => {
        try {
          return readHandoverDoc(
            fs.readFileSync(path.join(dir, entry.name), "utf8"),
            entry.name,
            `${prefix}/${entry.name}`,
            archived
          );
        } catch {
          return null;
        }
      })
      .filter((doc): doc is HandoverDoc => Boolean(doc));
  } catch {
    return [];
  }
}

export type VaultScope = { tenantSlug: string; applicationSlug: string };

/** Active and archived handovers under one tenant/application scope. */
export function scanHandoverDocs(scope: VaultScope): { active: HandoverDoc[]; archived: HandoverDoc[] } {
  const active: HandoverDoc[] = [];
  const archived: HandoverDoc[] = [];
  const seen = new Set<string>();
  for (const dir of candidateDirs(scope.tenantSlug, scope.applicationSlug)) {
    const prefix = `${scope.tenantSlug}/${scope.applicationSlug}`;
    for (const doc of [...readDir(dir, prefix, false), ...readDir(path.join(dir, "archived"), `${prefix}/archived`, true), ...readDir(path.join(dir, "archive"), `${prefix}/archive`, true)]) {
      if (seen.has(doc.name)) continue;
      seen.add(doc.name);
      (doc.archived ? archived : active).push(doc);
    }
  }
  return { active, archived };
}

export type EnhancementRecordRef = {
  id: string;
  ref: string;
  title: string;
  status: string;
  github_path: string | null;
};

export type RecordIndex = {
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
 * Which record a handover document belongs to. Exact file-name match first,
 * then a unique ref. An ambiguous ref is never guessed — it is reported as
 * unlinked instead.
 */
export function matchEnhancementRecord(doc: HandoverDoc, index: RecordIndex): EnhancementRecordRef | null {
  const exact = index.byPathName.get(doc.name);
  if (exact) return exact;
  const candidates = index.byRef.get(doc.ref ?? "") ?? [];
  if (candidates.length === 1) return candidates[0];
  const unlinked = candidates.filter((record) => !record.github_path);
  return unlinked.length === 1 ? unlinked[0] : null;
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

export type SyncExec = {
  all: (sql: string, ...params: any[]) => EnhancementRecordRef[];
  run: (sql: string, ...params: any[]) => unknown;
};

/**
 * Reconcile enhancement records with the handover documents in one vault scope.
 *
 * - an archived document means the implementation shipped, so the record becomes
 *   `Archived` (never overwriting `Rejected`);
 * - a `Built` document proves the build exists, promoting any earlier stage;
 * - a moved document re-points the stored path so downloads stay accurate.
 *
 * The database access is injected (SyncExec) so this function is testable
 * without a live hub database.
 */
export function syncScopeDocs(
  scope: VaultScope,
  exec: SyncExec,
  { apply = true }: { apply?: boolean } = {}
): { changes: HandoverSyncChange[]; scanned: { active: number; archived: number } } {
  const { active, archived } = scanHandoverDocs(scope);
  const changes: HandoverSyncChange[] = [];
  if (!active.length && !archived.length) return { changes, scanned: { active: 0, archived: 0 } };

  const records = exec.all(`SELECT id, ref, title, status, github_path FROM enhancements`);
  const index = indexEnhancementRecords(records);
  const matchFor = (doc: HandoverDoc) => matchEnhancementRecord(doc, index);

  for (const doc of [...archived, ...active]) {
    const record = matchFor(doc);
    if (!record) continue;

    if (doc.archived && record.status !== "Archived" && record.status !== "Rejected") {
      changes.push({ id: record.id, ref: record.ref, title: record.title, from: record.status, to: "Archived", reason: "archived-file", source: doc.relativePath });
      if (apply) {
        exec.run(
          `UPDATE enhancements SET status = 'Archived', archived_at = COALESCE(archived_at, datetime('now')), github_path = ?, updated_at = datetime('now') WHERE id = ?`,
          doc.relativePath,
          record.id
        );
      }
      continue;
    }

    const stages = pipelineStages();
    const builtRank = stages.indexOf("Built");
    const recordRank = stages.indexOf(record.status as EnhancementStatus);
    if (!doc.archived && doc.status === "Built" && recordRank >= 0 && recordRank < builtRank) {
      changes.push({ id: record.id, ref: record.ref, title: record.title, from: record.status, to: "Built", reason: "built-file", source: doc.relativePath });
      if (apply) {
        exec.run(`UPDATE enhancements SET status = 'Built', github_path = ?, updated_at = datetime('now') WHERE id = ?`, doc.relativePath, record.id);
      }
      continue;
    }

    const stored = record.github_path ?? "";
    if (stored && path.basename(stored) === doc.name && stored !== doc.relativePath) {
      changes.push({ id: record.id, ref: record.ref, title: record.title, from: record.status, to: record.status as EnhancementStatus, reason: "linked-file", source: doc.relativePath });
      if (apply) {
        exec.run(`UPDATE enhancements SET github_path = ?, updated_at = datetime('now') WHERE id = ?`, doc.relativePath, record.id);
      }
    }
  }
  return { changes, scanned: { active: active.length, archived: archived.length } };
}

export { statusAfterArchive, handoverFileName };
