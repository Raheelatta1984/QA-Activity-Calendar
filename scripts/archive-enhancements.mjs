import fs from "node:fs";
import path from "node:path";
import {
  ARCHIVED_NAMES_FILE,
  isBuildingHandover,
  isSafeHandoverName,
  parseArchiveMarkers,
  readLines,
  unique,
  writeLines,
} from "./lib/enhancement-utils.mjs";

/**
 * Archive only explicitly resolved, valid, active Building handovers. The
 * workflow supplies ARCHIVE_NAMES_FILE from a linked, labelled development
 * request. PR_BODY remains a backwards-compatible fallback for manual runs.
 * Never interpret text as a shell command or archive a relative path.
 */
const archiveNamesFile = process.env.ARCHIVE_NAMES_FILE;
const archivedNamesFile = process.env.ARCHIVED_NAMES_FILE || ARCHIVED_NAMES_FILE;
const rawNames = archiveNamesFile
  ? readLines(archiveNamesFile)
  : parseArchiveMarkers(process.env.PR_BODY || "");

const invalid = rawNames.filter((name) => !isSafeHandoverName(name));
if (invalid.length) throw new Error(`Refusing invalid archive filenames: ${invalid.join(", ")}`);
const names = unique(rawNames);

const root = path.join(process.cwd(), "lib", "future-enhancements");
const destinationDir = path.join(root, "archived");
const legacyDestinationDir = path.join(root, "archive");
const archived = [];

for (const name of names) {
  const source = path.join(root, name);
  const destination = path.join(destinationDir, name);
  const legacyDestination = path.join(legacyDestinationDir, name);

  if (!fs.existsSync(source)) {
    const alreadyArchived = fs.existsSync(destination) || fs.existsSync(legacyDestination);
    if (alreadyArchived) {
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
  if (!isBuildingHandover(content)) throw new Error(`${name} is not a Building handover.`);

  fs.mkdirSync(destinationDir, { recursive: true });
  fs.writeFileSync(destination, content.replace(/^status: "Building"$/m, 'status: "Archived"'));
  fs.unlinkSync(source);
  archived.push(name);
  console.log(`Archived ${name} into lib/future-enhancements/archived/`);
}

writeLines(archivedNamesFile, archived);
