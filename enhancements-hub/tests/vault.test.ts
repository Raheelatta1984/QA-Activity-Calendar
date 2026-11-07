/** Vault tests — write/relocate/remove against a temp directory. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-vault-test-"));
process.env.HUB_VAULT_DIR = tmp;

const { writeVaultMarkdown, relocateVaultMarkdown, removeVaultMarkdown, scanHandoverDocs, syncScopeDocs } = await import("../server/core/vault.ts");
const { renderEnhancementMarkdown } = await import("../server/core/markdown.ts");

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

test("vault: write keeps exactly one copy per document", () => {
  const scope = { tenantSlug: "acme", applicationSlug: "portal" };
  const write = writeVaultMarkdown({
    ...scope,
    fileName: "ENH-0001-export-view.md",
    content: '---\nref: "ENH-0001"\nstatus: "Building"\n---\nBody\n',
  });
  assert.equal(write.persistedToDisk, true);
  assert.equal(write.relativePath, "acme/portal/ENH-0001-export-view.md");
  assert.ok(fs.existsSync(write.fullPath!));

  const relocated = relocateVaultMarkdown({
    ...scope,
    githubPath: write.relativePath,
    ref: "ENH-0001",
    title: "Export view",
    status: "Archived",
    fallbackContent: write.fullPath ? fs.readFileSync(write.fullPath, "utf8") : "fallback",
  });
  assert.equal(relocated.relativePath, "acme/portal/archived/ENH-0001-export-view.md");
  assert.ok(!fs.existsSync(path.join(tmp, "acme/portal/ENH-0001-export-view.md")), "active copy removed");
  assert.ok(fs.existsSync(relocated.fullPath!));
  assert.ok(fs.readFileSync(relocated.fullPath!, "utf8").includes('status: "Archived"'));

  removeVaultMarkdown("acme", "portal", relocated.relativePath);
  assert.ok(!fs.existsSync(relocated.fullPath!));
});

test("vault: scanning finds active and archived documents", () => {
  const scope = { tenantSlug: "acme", applicationSlug: "portal" };
  writeVaultMarkdown({ ...scope, fileName: "ENH-0002-a.md", content: '---\nref: "ENH-0002"\nstatus: "Building"\n---\n' });
  writeVaultMarkdown({ ...scope, fileName: "ENH-0003-b.md", content: '---\nref: "ENH-0003"\nstatus: "Archived"\n---\n', archived: true });
  const { active, archived } = scanHandoverDocs(scope);
  assert.equal(active.length, 1);
  assert.equal(archived.length, 1);
  assert.equal(active[0].ref, "ENH-0002");
  assert.equal(archived[0].status, "Archived");
});

test("vault: sync promotes Built and archives on archived file", () => {
  const scope = { tenantSlug: "acme", applicationSlug: "portal" };
  const docs: { id: string; ref: string; title: string; status: string; github_path: string | null }[] = [
    { id: "e1", ref: "ENH-0001", title: "One", status: "Building", github_path: "acme/portal/ENH-0001-one.md" },
    { id: "e2", ref: "ENH-0002", title: "Two", status: "Accepted", github_path: null },
    { id: "e3", ref: "ENH-0003", title: "Three", status: "Rejected", github_path: null },
  ];
  const writes: any[] = [];
  const exec = {
    all: () => docs,
    run: (sql: string, ...params: any[]) => writes.push({ sql, params }),
  };

  // A Built document promotes the Building record…
  writeVaultMarkdown({ ...scope, fileName: "ENH-0001-one.md", content: '---\nref: "ENH-0001"\nstatus: "Built"\n---\n' });
  // …and an archived document archives ENH-0002 (matched by unique ref) but never touches the Rejected one.
  writeVaultMarkdown({ ...scope, fileName: "ENH-0002-two.md", content: '---\nref: "ENH-0002"\nstatus: "Archived"\n---\n', archived: true });
  writeVaultMarkdown({ ...scope, fileName: "ENH-0003-three.md", content: '---\nref: "ENH-0003"\nstatus: "Archived"\n---\n', archived: true });

  const { changes } = syncScopeDocs(scope, exec);
  const byRef = Object.fromEntries(changes.map((c) => [c.ref, c]));
  assert.equal(byRef["ENH-0001"].to, "Built");
  assert.equal(byRef["ENH-0001"].reason, "built-file");
  assert.equal(byRef["ENH-0002"].to, "Archived");
  assert.equal(byRef["ENH-0003"], undefined, "Rejected is never overwritten");
});

test("vault: markdown round-trip renders handover frontmatter for sync", () => {
  const { fileContent } = renderEnhancementMarkdown({
    ref: "ENH-0009",
    title: "Round trip",
    status: "Building",
    brief: "x",
  });
  const scope = { tenantSlug: "t", applicationSlug: "a" };
  const write = writeVaultMarkdown({ ...scope, fileName: "ENH-0009-round-trip.md", content: fileContent });
  const { active } = scanHandoverDocs(scope);
  assert.equal(active[0].ref, "ENH-0009");
  assert.equal(active[0].status, "Building");
  assert.ok(write.fullPath);
});
