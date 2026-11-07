import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ACTIVE_HANDOVER_DIR,
  ARCHIVED_HANDOVER_DIR,
  LEGACY_ARCHIVED_HANDOVER_DIR,
  scanHandoverDocs,
} from "../lib/enhancement-docs";
import {
  HANDOVER_STATUSES,
  isEnhancementStatus,
  pipelineStages,
  statusAfterArchive,
  statusAfterPublish,
} from "../lib/enhancement-status";
import { markHandoversBuilt } from "../scripts/mark-handovers-built.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NAME = "ENH-0004-example-work-enh-123.md";

function fixture(content: string, name = NAME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-lifecycle-"));
  const active = path.join(dir, ACTIVE_HANDOVER_DIR);
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, name), content);
  return dir;
}

const handover = (status: string) =>
  `---\nref: "ENH-0004"\ntitle: "Example work"\nstatus: "${status}"\n---\n\n# Example\n`;

test("the status flow keeps Building/Built published and archives exactly once", () => {
  // Publishing from any pre-publish stage lands in Building.
  assert.equal(statusAfterPublish("Accepted"), "Building");
  assert.equal(statusAfterPublish("Building"), "Building");
  assert.equal(statusAfterPublish("Built"), "Built");
  // Archiving is terminal but never overwrites a rejection.
  assert.equal(statusAfterArchive("Building"), "Archived");
  assert.equal(statusAfterArchive("Built"), "Archived");
  assert.equal(statusAfterArchive("Archived"), "Archived");
  assert.equal(statusAfterArchive("Rejected"), "Rejected");
  assert.deepEqual(HANDOVER_STATUSES, ["Building", "Built"]);
  assert.equal(pipelineStages().includes("Built"), true);
  assert.equal(isEnhancementStatus("Built"), true);
  assert.equal(isEnhancementStatus("Shipped"), false);
});

test("document scan distinguishes the archived tree from the active tree", () => {
  const dir = fixture(handover("Building"));
  fs.mkdirSync(path.join(dir, ARCHIVED_HANDOVER_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, ARCHIVED_HANDOVER_DIR, "ENH-0003-done-enh-9.md"), handover("Archived"));
  // The legacy archive/ folder is recognised too and never double-counted.
  fs.mkdirSync(path.join(dir, LEGACY_ARCHIVED_HANDOVER_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, LEGACY_ARCHIVED_HANDOVER_DIR, "ENH-0002-legacy-enh-8.md"), handover("Archived"));
  fs.writeFileSync(path.join(dir, ARCHIVED_HANDOVER_DIR, "README.md"), "# not a handover\n");
  try {
    const docs = scanHandoverDocs(dir);
    assert.deepEqual(docs.active.map((doc) => doc.name), [NAME]);
    assert.deepEqual(
      docs.archived.map((doc) => doc.name).sort(),
      ["ENH-0002-legacy-enh-8.md", "ENH-0003-done-enh-9.md"]
    );
    assert.equal(docs.active[0].status, "Building");
    assert.equal(docs.archived[0].archived, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mark-handovers-built promotes only resolved Building documents", () => {
  const dir = fixture(handover("Building"));
  const other = "ENH-0005-untouched-enh-456.md";
  fs.writeFileSync(path.join(dir, ACTIVE_HANDOVER_DIR, other), handover("Building"));
  try {
    const results = markHandoversBuilt({ names: [NAME, other], root: dir });
    assert.deepEqual(results.map((r) => r.status), ["built", "built"]);
    const active = fs.readFileSync(path.join(dir, ACTIVE_HANDOVER_DIR, NAME), "utf8");
    assert.match(active, /^status: "Built"$/m);
    // Running again is idempotent.
    assert.equal(markHandoversBuilt({ names: [NAME], root: dir })[0].status, "already-built");
    // A handover that is not active can never be promoted.
    fs.writeFileSync(path.join(dir, ACTIVE_HANDOVER_DIR, other), handover("Archived"));
    assert.equal(markHandoversBuilt({ names: [other], root: dir })[0].status, "not-building");
    assert.equal(markHandoversBuilt({ names: ["ENH-9999-missing-enh-0.md"], root: dir })[0].status, "missing");
    assert.throws(() => markHandoversBuilt({ names: ["../../bad.md"], root: dir }), /Refusing invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the archive step accepts Built handovers and refuses anything else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-archive-built-"));
  const root = path.join(dir, ACTIVE_HANDOVER_DIR);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, NAME), handover("Built"));
  const rejected = "ENH-0006-rejected-enh-777.md";
  fs.writeFileSync(path.join(root, rejected), handover("Rejected"));
  const namesFile = path.join(dir, "names.txt");
  const archivedFile = path.join(dir, "archived.txt");
  const script = path.join(repoRoot, "scripts/archive-enhancements.mjs");
  const run = (names: string[]) => {
    fs.writeFileSync(namesFile, `${names.join("\n")}\n`);
    return execFileSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ARCHIVE_NAMES_FILE: namesFile, ARCHIVED_NAMES_FILE: archivedFile, PR_BODY: "" },
      stdio: "pipe",
    });
  };
  try {
    run([NAME]);
    assert.equal(fs.existsSync(path.join(root, NAME)), false);
    const archived = fs.readFileSync(path.join(dir, ARCHIVED_HANDOVER_DIR, NAME), "utf8");
    assert.match(archived, /^status: "Archived"$/m);
    assert.equal(fs.readFileSync(archivedFile, "utf8").trim(), NAME);
    assert.throws(() => run([rejected]), /not an active Building or Built handover/);
    assert.equal(fs.existsSync(path.join(root, rejected)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the deploy sync is a no-op when the build ships no handover documents", async () => {
  const { runDeploySync } = await import("../lib/enhancement-docs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-sync-empty-"));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const result = await runDeploySync({ ...process.env, SEED_DEMO_DATA: "false" });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /no handover documents/);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the deploy sync honours the opt-out flag", async () => {
  const { runDeploySync } = await import("../lib/enhancement-docs");
  const dir = fixture(handover("Building"));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const result = await runDeploySync({ ...process.env, ENHANCEMENT_DOC_SYNC: "false" });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /ENHANCEMENT_DOC_SYNC/);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
