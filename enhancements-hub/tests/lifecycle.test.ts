/**
 * Lifecycle + markdown determinism tests — ported in spirit from the source
 * project's tests/enhancement-lifecycle.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENHANCEMENT_STATUSES,
  canTransition,
  statusAfterArchive,
  hasHandover,
  pipelineStages,
} from "../server/core/status.ts";
import {
  enhancementFileName,
  handoverFileName,
  parseFrontmatter,
  renderEnhancementMarkdown,
  updateFrontmatterStatus,
  parseAiFields,
} from "../server/core/markdown.ts";
import { draftEnhancement, suggestEnhancementFields } from "../server/core/draft.ts";

test("lifecycle: pipeline order and handover statuses", () => {
  assert.deepEqual(pipelineStages(), ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived"]);
  assert.deepEqual(hasHandover("Building"), true);
  assert.deepEqual(hasHandover("Built"), true);
  assert.deepEqual(hasHandover("Submitted"), false);
  assert.deepEqual(hasHandover(null), false);
});

test("lifecycle: transition guards", () => {
  assert.equal(canTransition("Submitted", "Reviewing"), true);
  assert.equal(canTransition("Submitted", "Built"), true, "forward jumps allowed; publishing contract enforced by service layer");
  assert.equal(canTransition("Archived", "Submitted"), false, "terminal Archived never reopens silently");
  assert.equal(canTransition("Archived", "Reviewing"), true, "deliberate reopen is allowed");
  assert.equal(canTransition("Rejected", "Reviewing"), true);
  assert.equal(canTransition("Rejected", "Accepted"), false);
  assert.equal(canTransition("Submitted", "Submitted"), false);
  assert.equal(canTransition("Nope", "Submitted"), false);
});

test("lifecycle: statusAfterArchive keeps deliberate decisions", () => {
  assert.equal(statusAfterArchive("Building"), "Archived");
  assert.equal(statusAfterArchive("Built"), "Archived");
  assert.equal(statusAfterArchive("Rejected"), "Rejected");
  assert.equal(statusAfterArchive("Archived"), "Archived");
});

test("markdown: rendering is deterministic and frontmatter-faithful", () => {
  const input = {
    ref: "ENH-0001",
    title: "Export capacity view",
    status: "Building",
    applicationName: "Portal",
    tenantName: "acme",
    submittedBy: "Reema",
    submittedOn: "2026-11-08",
    aiFields: ["title", "brief"],
    brief: "Shareable monthly export.",
    includeFooter: false,
  };
  const first = renderEnhancementMarkdown(input);
  const second = renderEnhancementMarkdown(input);
  assert.equal(first.fileContent, second.fileContent, "same input, same bytes");

  const meta = parseFrontmatter(first.fileContent);
  assert.ok(meta, "frontmatter parses");
  assert.equal(meta!.ref, "ENH-0001");
  assert.equal(meta!.status, "Building");
  assert.equal(meta!.application, "Portal");
  assert.equal(meta!.ai_fields, "title, brief");
  assert.ok(first.fileContent.includes("## Brief\nShareable monthly export."));
});

test("markdown: filenames follow the handover contract", () => {
  assert.equal(enhancementFileName("ENH-0007", "Add Export!"), "ENH-0007-add-export.md");
  assert.match(handoverFileName("ENH-0007", "Add Export", "enh_ab12-cd34"), /^ENH-0007-add-export-enh-ab12-cd34\.md$/);
});

test("markdown: status rewrites only touch the frontmatter", () => {
  const doc = `---\nref: "ENH-0001"\nstatus: "Building"\n---\n\nBody mentions status: "Building" inline.`;
  const updated = updateFrontmatterStatus(doc, "Archived");
  assert.ok(updated.startsWith(`---\nref: "ENH-0001"\nstatus: "Archived"`));
  assert.ok(updated.includes('Body mentions status: "Building" inline.'), "body untouched");
});

test("markdown: ai_fields parsing tolerates junk", () => {
  assert.deepEqual(parseAiFields('["title","brief"]'), ["title", "brief"]);
  assert.deepEqual(parseAiFields("not json"), []);
  assert.deepEqual(parseAiFields(null), []);
});

test("draft: extracts title, requirements and criteria from raw text", () => {
  const draft = draftEnhancement({
    raw: "We need to export the monthly capacity view. Managers must be able to share it with delivery leads. Add a CSV button to the toolbar.",
    applicationName: "Capacity Planner",
    outcome: "No more spreadsheet hand-offs.",
  });
  assert.equal(draft.provider, "local");
  assert.ok(draft.title.toLowerCase().includes("export"), `title from request: ${draft.title}`);
  assert.ok(draft.requirements.includes("Managers must be able to share it"), "modal sentence captured");
  assert.ok(draft.impacts.includes("Capacity Planner"));
  assert.equal(draft.expectedOutcome, "No more spreadsheet hand-offs.", "author outcome wins");
  assert.ok(draft.successCriteria.split("\n").length >= 3);
  assert.equal(ENHANCEMENT_STATUSES.length, 7);
});

test("draft: suggestions only fill untouched fields", () => {
  const raw = "Please add a welcome note when users log in so they know what changed since their last visit.";
  const suggestions = suggestEnhancementFields({ raw, applicationName: "Portal", title: "Login welcome note" });
  assert.equal(suggestions.title, undefined, "author already has a title");
  assert.ok((suggestions.brief?.length ?? 0) >= 1);
  assert.ok((suggestions.requirements?.length ?? 0) >= 1);
  assert.ok((suggestions.outcome?.length ?? 0) >= 1);
});
