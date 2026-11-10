import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { all } from "./db";

export type Enhancement = {
  id: string;
  ref: string;
  title: string;
  brief: string | null;
  requirements: string | null;
  impacts: string | null;
  expected_outcome: string | null;
  success_criteria: string | null;
  markdown: string | null;
  status: string;
  github_path: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  department_id: string | null;
  department_name: string | null;
  ai_fields: string | null;
  votes: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** `app` or `github` — where the proposal first appeared. */
  source: string;
  /** GitHub bridge (v2) remote pointer and last synchronisation. */
  github_repo: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_state: string | null;
  github_labels: string | null;
  github_updated_at: string | null;
  github_synced_at: string | null;
  github_direction: string | null;
};

const BUNDLE_VAULT = path.join(process.cwd(), "enhancements");
const TMP_VAULT = path.join(os.tmpdir(), "enhancements");
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

function preferredVaultDir(): string {
  const configured = process.env.ENHANCEMENT_VAULT_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (isServerlessRuntime()) return TMP_VAULT;
  return BUNDLE_VAULT;
}

export function vaultInfo(): { dir: string; ephemeral: boolean; serverless: boolean } {
  const serverless = isServerlessRuntime();
  const preferred = preferredVaultDir();
  if (isDirWritable(preferred)) {
    const inTmp = preferred === TMP_VAULT || preferred.startsWith(`${os.tmpdir()}${path.sep}`);
    return { dir: preferred, ephemeral: serverless || inTmp, serverless };
  }
  return { dir: TMP_VAULT, ephemeral: true, serverless };
}

export function slugifyEnhancement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function enhancementFileName(ref: string, title: string): string {
  return `${ref}-${slugifyEnhancement(title) || "enhancement"}.md`;
}

export function frontmatter(meta: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: "${String(value).replace(/"/g, "'")}"`);
  return `---\n${lines.join("\n")}\n---\n`;
}

export function renderEnhancementMarkdown(input: {
  ref: string;
  title: string;
  status: string;
  submittedBy?: string | null;
  submittedOn?: string | null;
  sections?: string | null;
  aiFields?: string[];
  rawMarkdown?: string | null;
  brief?: string | null;
  requirements?: string | null;
  impacts?: string | null;
  expectedOutcome?: string | null;
  successCriteria?: string | null;
  includeFooter?: boolean;
}): { body: string; fileContent: string } {
  const trimmed = String(input.rawMarkdown ?? "").trim();
  const body =
    trimmed ||
    `# ${input.title}\n\n## Brief\n${input.brief ?? "_To be confirmed_"}\n\n## Requirements\n${
      input.requirements ?? "_To be confirmed_"
    }\n\n## Impacts\n${input.impacts ?? "_To be confirmed_"}\n\n## Expected outcome\n${
      input.expectedOutcome ?? "_To be confirmed_"
    }\n\n## Success criteria\n${input.successCriteria ?? "_To be confirmed_"}\n`;

  const aiFields = (input.aiFields ?? []).filter(Boolean);
  const header = frontmatter({
    ref: input.ref,
    title: input.title,
    status: input.status,
    submitted_by: input.submittedBy ?? undefined,
    submitted_on: input.submittedOn ?? undefined,
    app_sections: input.sections ?? undefined,
    ai_fields: aiFields.length ? aiFields.join(", ") : undefined,
    source: "HFM QA Calendar — Future Enhancements",
  });

  const footer =
    input.includeFooter === false
      ? ""
      : `\n\n---\n\n_Generated from the in-app enhancement vault. Fields drafted by the local assistant: ${
          aiFields.length ? aiFields.join(", ") : "none"
        }. Review with every change set and archive once built and tested._`;

  const normalizedBody = body.replace(/\s+$/, "");
  return {
    body,
    fileContent: `${header}${normalizedBody}${footer}\n`,
  };
}

function writeIntoDir(baseDir: string, safeName: string, content: string, archived: boolean): string {
  const targetDir = archived ? path.join(baseDir, "archive") : baseDir;
  fs.mkdirSync(targetDir, { recursive: true });
  const fullPath = path.join(targetDir, safeName);
  fs.writeFileSync(fullPath, content, "utf8");
  const counterpart = archived ? path.join(baseDir, safeName) : path.join(baseDir, "archive", safeName);
  try {
    if (fs.existsSync(counterpart)) fs.unlinkSync(counterpart);
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

/**
 * Write an enhancement Markdown file to the configured/repository vault, or
 * transparently fall back to /tmp/enhancements when the bundle filesystem is
 * read-only (e.g. Vercel /var/task returning EROFS).
 */
export function writeVaultMarkdown(options: {
  fileName: string;
  content: string;
  archived?: boolean;
  previousPath?: string | null;
}): VaultWriteResult {
  const safeName = path.basename(options.fileName);
  const archived = Boolean(options.archived);
  const relativePath = archived ? `enhancements/archive/${safeName}` : `enhancements/${safeName}`;
  const preferred = preferredVaultDir();
  const serverless = isServerlessRuntime();

  const cleanupOldFile = (baseDir: string) => {
    if (!options.previousPath) return;
    const oldName = path.basename(options.previousPath);
    if (!oldName || oldName === safeName) return;
    for (const candidate of [path.join(baseDir, oldName), path.join(baseDir, "archive", oldName)]) {
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
      const inTmp = preferred === TMP_VAULT || preferred.startsWith(`${os.tmpdir()}${path.sep}`);
      return {
        relativePath,
        fullPath,
        ephemeral: serverless || inTmp,
        persistedToDisk: true,
      };
    } catch (error) {
      unwritableDirs.add(preferred);
      console.warn(
        `[enhancements] ${preferred} is not writable (${(error as Error).message}); falling back to ${TMP_VAULT}.`
      );
    }
  }

  if (preferred !== TMP_VAULT) {
    try {
      const fullPath = writeIntoDir(TMP_VAULT, safeName, options.content, archived);
      cleanupOldFile(TMP_VAULT);
      return {
        relativePath,
        fullPath,
        ephemeral: true,
        persistedToDisk: true,
      };
    } catch (fallbackError) {
      console.warn(
        `[enhancements] Fallback vault ${TMP_VAULT} is also not writable (${(fallbackError as Error).message}); keeping proposal in database only.`
      );
    }
  }

  return {
    relativePath,
    fullPath: null,
    ephemeral: true,
    persistedToDisk: false,
  };
}

function candidateVaultDirs(): string[] {
  const dirs: string[] = [];
  const configured = process.env.ENHANCEMENT_VAULT_DIR?.trim();
  if (configured) {
    dirs.push(path.resolve(configured));
    if (dirs[0] !== TMP_VAULT) dirs.push(TMP_VAULT);
    return dirs;
  }
  if (isServerlessRuntime() || unwritableDirs.has(BUNDLE_VAULT)) {
    dirs.push(TMP_VAULT, BUNDLE_VAULT);
  } else {
    dirs.push(BUNDLE_VAULT, TMP_VAULT);
  }
  return dirs;
}

function findExistingVaultFile(safeName: string): string | null {
  for (const dir of candidateVaultDirs()) {
    for (const candidate of [path.join(dir, safeName), path.join(dir, "archive", safeName)]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore unreadable paths */
      }
    }
  }
  return null;
}

function updateFrontmatterStatus(content: string, status: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  const header = content.slice(0, end);
  const rest = content.slice(end);
  if (/^status:\s*".*"$/m.test(header)) {
    return `${header.replace(/^status:\s*".*"$/m, `status: "${status.replace(/"/g, "'")}"`)}${rest}`;
  }
  return `${header}\nstatus: "${status.replace(/"/g, "'")}"${rest}`;
}

export function relocateVaultMarkdown(options: {
  githubPath: string | null;
  ref: string;
  title: string;
  status: string;
  fallbackContent: string;
}): VaultWriteResult {
  const safeName = options.githubPath
    ? path.basename(options.githubPath)
    : enhancementFileName(options.ref, options.title);
  const existingPath = findExistingVaultFile(safeName);
  let content = options.fallbackContent;
  if (existingPath) {
    try {
      content = updateFrontmatterStatus(fs.readFileSync(existingPath, "utf8"), options.status);
    } catch {
      /* fall back to synthesised markdown */
    }
  }
  return writeVaultMarkdown({
    fileName: safeName,
    content,
    archived: options.status === "Archived",
  });
}

export function removeVaultMarkdown(githubPath: string | null): void {
  if (!githubPath) return;
  const safeName = path.basename(githubPath);
  if (!safeName) return;
  for (const dir of candidateVaultDirs()) {
    if (dir === BUNDLE_VAULT && (isServerlessRuntime() || unwritableDirs.has(BUNDLE_VAULT))) continue;
    for (const candidate of [path.join(dir, safeName), path.join(dir, "archive", safeName)]) {
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* file cleanup is best-effort */
      }
    }
  }
}

export function readEnhancementMarkdown(item: {
  ref: string;
  title: string;
  brief?: string | null;
  requirements?: string | null;
  impacts?: string | null;
  expected_outcome?: string | null;
  success_criteria?: string | null;
  markdown?: string | null;
  status?: string | null;
  github_path?: string | null;
  submitted_by_name?: string | null;
  ai_fields?: string | null;
  created_at?: string | null;
}): { filename: string; content: string } {
  const safeName = item.github_path
    ? path.basename(item.github_path)
    : enhancementFileName(item.ref, item.title);
  const onDisk = findExistingVaultFile(safeName);
  if (onDisk) {
    try {
      return { filename: safeName, content: item.status ? updateFrontmatterStatus(fs.readFileSync(onDisk, "utf8"), item.status) : fs.readFileSync(onDisk, "utf8") };
    } catch {
      /* fall through to database synthesis */
    }
  }

  let parsedAiFields: string[] = [];
  if (item.ai_fields) {
    try {
      const parsed = JSON.parse(item.ai_fields);
      if (Array.isArray(parsed)) parsedAiFields = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      /* ignore */
    }
  }

  const raw = String(item.markdown ?? "").trim();
  if (raw.startsWith("---\n")) {
    return { filename: safeName, content: `${raw}\n` };
  }

  const { fileContent } = renderEnhancementMarkdown({
    ref: item.ref,
    title: item.title,
    status: item.status ?? "Submitted",
    submittedBy: item.submitted_by_name ?? undefined,
    submittedOn: item.created_at ? String(item.created_at).slice(0, 10) : undefined,
    aiFields: parsedAiFields,
    rawMarkdown: raw || null,
    brief: item.brief,
    requirements: item.requirements,
    impacts: item.impacts,
    expectedOutcome: item.expected_outcome,
    successCriteria: item.success_criteria,
  });
  return { filename: safeName, content: fileContent };
}

export function listEnhancements(companyId?: string | null): Enhancement[] {
  return all<Enhancement>(
    `SELECT e.*, p.name AS submitted_by_name, d.name AS department_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
       LEFT JOIN departments d ON d.id = e.department_id
      ${companyId ? "WHERE e.company_id = ?" : ""}
      ORDER BY CASE e.status WHEN 'Reviewing' THEN 1 WHEN 'Submitted' THEN 2 WHEN 'Accepted' THEN 3
                             WHEN 'Building' THEN 4 WHEN 'Built' THEN 5 WHEN 'Archived' THEN 6 ELSE 7 END,
               e.created_at DESC`,
    ...(companyId ? [companyId] : [])
  );
}

function scanVaultDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        for (const file of fs.readdirSync(sub)) {
          if (file.endsWith(".md") && file.toLowerCase() !== "readme.md") {
            out.push(`enhancements/${entry.name}/${file}`);
          }
        }
      } else if (entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
        out.push(`enhancements/${entry.name}`);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

export function vaultFiles(): string[] {
  const info = vaultInfo();
  if (!info.ephemeral) {
    return scanVaultDir(info.dir);
  }

  const byFile = new Map<string, string>();
  try {
    for (const row of all<{ github_path: string | null }>(
      `SELECT github_path FROM enhancements WHERE github_path IS NOT NULL AND github_path <> ''`
    )) {
      if (row.github_path) {
        byFile.set(path.basename(row.github_path), row.github_path);
      }
    }
  } catch {
    /* database may not be initialised in pure unit contexts */
  }
  for (const rel of scanVaultDir(info.dir)) {
    byFile.set(path.basename(rel), rel);
  }
  return [...byFile.values()].sort();
}
