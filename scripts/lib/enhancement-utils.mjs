/** Shared, deliberately narrow conventions for the enhancement automation. */
import fs from "node:fs";
import path from "node:path";

export const ACTIVE_DIR = "lib/future-enhancements";
export const ARCHIVE_DIR = "lib/future-enhancements/archived";
export const LEGACY_ARCHIVE_DIR = "lib/future-enhancements/archive";
export const HANDOVER_LABEL = "arena-handover";
export const ARCHIVE_PR_LABEL = "enhancement-archive";
export const REQUIRED_CHECK_NAME = "Build and test";
export const DEFAULT_BRANCH_PREFIXES = ["copilot/", "enh/", "enhancement/", "automation/"];
export const DEFAULT_TMP_DIR = ".tmp";
export const ARCHIVE_NAMES_FILE = ".tmp/enhancement-archive-names.txt";
export const ARCHIVED_NAMES_FILE = ".tmp/enhancement-archived-names.txt";
export const ISSUE_NUMBERS_FILE = ".tmp/enhancement-issue-numbers.txt";

const HANDOVER_NAME_RE = /^ENH-[0-9]+-[a-z0-9-]+\.md$/;
const ARCHIVE_MARKER_RE = /^Enhancement-Archive:\s*(ENH-[0-9]+-[a-z0-9-]+\.md)\s*$/gm;

export function isSafeHandoverName(value) {
  return HANDOVER_NAME_RE.test(String(value || ""));
}

export function isHexSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ""));
}

/** Environment flags: absent/empty means the documented default. */
export function envFlag(env, key, defaultValue = false) {
  const raw = String(env[key] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return !["false", "0", "off", "no"].includes(raw);
}

export function isZeroSha(value) {
  return /^0{40}$/.test(String(value || ""));
}

export function parseArchiveMarkers(body) {
  return [...new Set(
    [...String(body || "").matchAll(ARCHIVE_MARKER_RE)].map((match) => match[1]).filter(isSafeHandoverName),
  )];
}

export function archiveMarker(name) {
  if (!isSafeHandoverName(name)) throw new Error(`Invalid handover filename: ${name}`);
  return `Enhancement-Archive: ${name}`;
}

export function handoverMarker(name) {
  if (!isSafeHandoverName(name)) throw new Error(`Invalid handover filename: ${name}`);
  return `<!-- enhancement-handover: ${name} -->`;
}

export function parseHandoverMarker(body) {
  const match = String(body || "").match(/<!--\s*enhancement-handover:\s*([^\s>]+)\s*-->/i);
  return match && isSafeHandoverName(match[1]) ? match[1] : null;
}

export function parseFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return text.slice(4, end);
}

export function isBuildingHandover(content) {
  const header = parseFrontmatter(content);
  return Boolean(header && /^status:\s*"Building"\s*$/m.test(header));
}

export function handoverTitle(content, fallback = "Approved enhancement") {
  const header = parseFrontmatter(content);
  const match = header?.match(/^title:\s*"([^"\n]*)"\s*$/m);
  // The title is untrusted frontmatter: keep it single-line and free of markup
  // before using it in an issue title, heading or agent prompt.
  const title = match?.[1]?.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, 200);
  return title || fallback;
}

/** Extract issue numbers only for same-repository URLs; other refs are filtered by issue labels later. */
export function parseIssueReferences(body, repoFullName = "", limit = 20) {
  const text = String(body || "");
  const numbers = new Set();
  const add = (value) => {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  };
  const urlPattern = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\b/gi;
  for (const match of text.matchAll(urlPattern)) {
    if (!repoFullName || `${match[1]}/${match[2]}`.toLowerCase() === repoFullName.toLowerCase()) add(match[3]);
  }
  const keywordPattern = /\b(?:closes?|closed|fixes?|fixed|resolves?|resolved|refs?|references?)\s*[:#]?\s*#?(\d+)\b/gi;
  for (const match of text.matchAll(keywordPattern)) add(match[1]);
  for (const match of text.matchAll(/(?<![\w/])#(\d+)\b/g)) add(match[1]);
  for (const match of text.matchAll(/\bGH-(\d+)\b/gi)) add(match[1]);
  return [...numbers].slice(0, limit);
}

export function issueHasLabel(issue, label) {
  return (issue?.labels || []).some((entry) =>
    (typeof entry === "string" ? entry : entry?.name) === label,
  );
}

export function prHasLabel(pullRequest, label) {
  return issueHasLabel(pullRequest, label);
}

export function isSafeBranchName(ref) {
  const value = String(ref || "");
  return (
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".lock")
  );
}

export function parseBranchPrefixes(env = process.env) {
  const raw = env.BRANCH_CLEANUP_PREFIXES;
  if (raw === undefined) return DEFAULT_BRANCH_PREFIXES;
  const prefixes = String(raw)
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!prefixes.length) return DEFAULT_BRANCH_PREFIXES;
  if (prefixes.includes("*") || prefixes.some((prefix) => prefix.includes("*"))) {
    throw new Error("BRANCH_CLEANUP_PREFIXES must list explicit prefixes, not a wildcard.");
  }
  return [...new Set(prefixes)];
}

export function hasAutomationPrefix(ref, prefixes = DEFAULT_BRANCH_PREFIXES) {
  const value = String(ref || "");
  return prefixes.some((prefix) => prefix && value.startsWith(prefix));
}

export function encodeBranchPath(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

export function readLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function writeLines(file, values) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, values.length ? `${values.join("\n")}\n` : "");
}

export function appendGithubOutput(env, values) {
  const output = env.GITHUB_OUTPUT;
  if (!output) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "%0A")}\n`);
  fs.appendFileSync(output, lines.join(""));
}

export function appendStepSummary(env, heading, lines) {
  const output = env.GITHUB_STEP_SUMMARY;
  if (!output) return;
  fs.appendFileSync(output, `### ${heading}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`);
}

export function unique(values) {
  return [...new Set(values)];
}
