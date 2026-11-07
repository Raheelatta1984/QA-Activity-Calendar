#!/usr/bin/env node
/**
 * Archive resolved handovers in a TARGET repository's vault.
 *
 * Ported from the source project's scripts/archive-enhancements.mjs, generalised:
 * the vault directory comes from --dir (default future-enhancements) so any
 * repository can adopt the same completion automation regardless of layout.
 *
 * Inputs (env): ARCHIVE_NAMES_FILE (preferred) or PR_BODY with
 * `Enhancement-Archive: <filename>` markers. Only explicitly resolved, valid,
 * active Building/Built handovers are archived — never a relative path, never a
 * deliberate Rejected record, never an already-archived file (that is an error,
 * so a doubled automation run fails loudly instead of silently).
 *
 * Usage: node archive-handovers.mjs [--dir future-enhancements]
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dirFlag = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : undefined;
const VAULT = path.resolve(process.cwd(), dirFlag || process.env.HUB_HANDOVER_DIR || "future-enhancements");
const DEST = path.join(VAULT, "archived");
const LEGACY_DEST = path.join(VAULT, "archive");
const HANDOVER_NAME_RE = /^ENH-[0-9]+-[a-z0-9-]+\.md$/i;

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseArchiveMarkers(prBody) {
  return String(prBody || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^Enhancement-Archive:\s*(\S+)\s*$/i)?.[1])
    .filter(Boolean);
}

const archiveNamesFile = process.env.ARCHIVE_NAMES_FILE;
const archivedNamesFile = process.env.ARCHIVED_NAMES_FILE || path.join(".tmp", "archived-handovers.txt");
const rawNames = archiveNamesFile ? readLines(archiveNamesFile) : parseArchiveMarkers(process.env.PR_BODY || "");

const invalid = rawNames.filter((name) => !HANDOVER_NAME_RE.test(name));
if (invalid.length) throw new Error(`Refusing invalid handover filenames: ${invalid.join(", ")}`);
const names = [...new Set(rawNames)];

const archived = [];
for (const name of names) {
  const source = path.join(VAULT, name);
  const destination = path.join(DEST, name);
  const legacyDestination = path.join(LEGACY_DEST, name);

  if (!fs.existsSync(source)) {
    if (fs.existsSync(destination) || fs.existsSync(legacyDestination)) {
      console.log(`${name} is already archived; skipping.`);
      archived.push(name);
      continue;
    }
    console.warn(`No active handover ${name}; skipping.`);
    continue;
  }
  if (fs.existsSync(destination) || fs.existsSync(legacyDestination)) {
    throw new Error(`Archive already exists: ${name}; refusing to overwrite.`);
  }

  const content = fs.readFileSync(source, "utf8");
  const status = content.match(/^status:\s*"([^"]+)"/m)?.[1] ?? "";
  if (status !== "Building" && status !== "Built") {
    throw new Error(`${name} is not an active Building or Built handover (status: "${status}").`);
  }

  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(destination, content.replace(/^status:\s*"Building"$/m, 'status: "Archived"').replace(/^status:\s*"Built"$/m, 'status: "Archived"'));
  fs.unlinkSync(source);
  archived.push(name);
  console.log(`Archived ${name} into ${path.relative(process.cwd(), DEST)}/`);
}

if (archiveNamesFile || process.env.WRITE_ARCHIVED_NAMES === "true") {
  fs.mkdirSync(path.dirname(archivedNamesFile), { recursive: true });
  fs.writeFileSync(archivedNamesFile, archived.join("\n"), "utf8");
}
console.log(archived.length ? `Done: ${archived.length} handover(s) archived.` : "Nothing to archive.");
