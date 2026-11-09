import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated database for the HFM import acceptance suite.
const dbPath = path.join(os.tmpdir(), `qa-calendar-hfm-${process.pid}.db`);
process.env.DATABASE_FILE = dbPath;
process.env.SEED_DEMO_DATA = "true";
process.env.AI_PROVIDER = "local";
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  } catch {
    /* ignore */
  }
}

const { bootstrapDatabase } = await import("../lib/seed");
const { all, get, run } = await import("../lib/db");
const {
  runHfmImport,
  verifyHfmImport,
  rollbackHfmImport,
  EXPECTED_COUNTS,
  MASTER_ACTIVITY_ROWS,
  PIPELINE_ROWS,
  MANUAL_EXCLUSION_ROWS,
} = await import("../lib/hfm-import");
const { computeEffectiveDuration } = await import("../lib/pipeline");
const { detectIssues } = await import("../lib/validation");
const {
  loadOrg,
  scopeFor,
  canAdminDepartment,
  canManageDepartment,
  canAdmin,
  scopedDepartmentId,
} = await import("../lib/access");

before(() => {
  bootstrapDatabase();
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("embedded source payload matches expected counts before any write", () => {
  assert.equal(MASTER_ACTIVITY_ROWS.length, EXPECTED_COUNTS.master_activities);
  assert.equal(PIPELINE_ROWS.length, EXPECTED_COUNTS.pending_pipeline);
  assert.equal(MANUAL_EXCLUSION_ROWS.length, EXPECTED_COUNTS.manual_exclusions);
});

test("dry-run validates without writing anything", () => {
  const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities'")?.n ?? 0;
  const report = runHfmImport({ apply: false });
  assert.deepEqual(report.errors, [], `dry-run errors: ${report.errors.join("; ")}`);
  const afterCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities'")?.n ?? 0;
  assert.equal(afterCount, before, "dry-run must not write rows");
});

let batchId: string | null = null;

test("apply commits the HFM snapshot (52 master / 15 pipeline / 14 exclusions)", () => {
  const report = runHfmImport({ apply: true, requestedBy: "Raheel Atta" });
  assert.deepEqual(report.errors, [], `apply errors: ${report.errors.join("; ")}`);
  assert.equal(report.activities.inserted, EXPECTED_COUNTS.master_activities);
  assert.equal(report.pipeline.inserted, EXPECTED_COUNTS.pending_pipeline);
  assert.equal(report.exclusions.inserted, EXPECTED_COUNTS.manual_exclusions);
  assert.ok(report.batchId, "apply must record an import batch");
  batchId = report.batchId;
  assert.equal(
    get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities'")?.n,
    EXPECTED_COUNTS.master_activities
  );
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities' AND active = 1")?.n, 41);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities' AND active = 0")?.n, 11);
});

test("re-apply is fully idempotent (everything unchanged)", () => {
  const report = runHfmImport({ apply: true, requestedBy: "Raheel Atta" });
  assert.deepEqual(report.errors, []);
  assert.equal(report.activities.inserted, 0);
  assert.equal(report.activities.unchanged, EXPECTED_COUNTS.master_activities);
  assert.equal(report.pipeline.inserted, 0);
  assert.equal(report.pipeline.unchanged, EXPECTED_COUNTS.pending_pipeline);
  assert.equal(report.exclusions.inserted, 0);
  assert.equal(report.exclusions.unchanged, EXPECTED_COUNTS.manual_exclusions);
});

test("a manually re-parented department survives re-import (conflict, not overwrite)", () => {
  const row = get<{ id: string; department_id: string }>(
    "SELECT id, department_id FROM activities WHERE source_dataset = 'tblActivities' LIMIT 1"
  )!;
  const otherDept = get<{ id: string }>("SELECT id FROM departments WHERE name <> 'HFM IT QA' LIMIT 1")!;
  run("UPDATE activities SET department_id = ? WHERE id = ?", otherDept.id, row.id);
  const report = runHfmImport({ apply: true, requestedBy: "Raheel Atta" });
  assert.deepEqual(report.errors, []);
  const after = get<{ department_id: string }>("SELECT department_id FROM activities WHERE id = ?", row.id)!;
  assert.equal(after.department_id, otherDept.id, "manual move is not overwritten by re-import");
  assert.ok(
    report.conflicts.some((c) => c.entity === "activities" && c.field === "department_id" && c.id === row.id),
    "the divergence is recorded as a conflict"
  );
  // Restore the source department before running the remaining acceptance checks.
  run("UPDATE activities SET department_id = ? WHERE id = ?", row.department_id, row.id);
  const restore = runHfmImport({ apply: true, requestedBy: "Raheel Atta" });
  assert.deepEqual(restore.errors, []);
});

test("acceptance verification passes every check", () => {
  const result = verifyHfmImport();
  const failed = result.checks.filter((c) => !c.pass);
  assert.equal(result.failed, 0, `failed checks: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  assert.ok(result.passed >= 20);
});

test("source fidelity: literal IDs, fractions, raw text and NULL preservation", () => {
  const qa008 = get<{ external_source_id: string }>("SELECT external_source_id FROM activities WHERE external_source_id = 'QA-008'");
  assert.ok(qa008, "QA-008 literal source ID must be preserved");
  const qa0013 = get<{ external_source_id: string }>("SELECT external_source_id FROM activities WHERE external_source_id = 'QA-00013'");
  assert.ok(qa0013, "QA-00013 literal source ID must be preserved");
  const rawAmp = get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE instr(notes, '&amp;') > 0 OR instr(detail, '&amp;') > 0")?.n ?? 0;
  assert.ok(rawAmp > 0, "raw '&amp;' entities must be preserved verbatim");
  const t1 = get<{ automation_fraction: number | null; automation_percent: number | null }>(
    "SELECT automation_fraction, automation_percent FROM recording_pipeline WHERE external_source_id = 'TEST-001'"
  );
  assert.equal(t1?.automation_fraction, 0.55, "TEST-001 fraction must stay 0.55");
  assert.equal(t1?.automation_percent, 55);
  const t9 = get<{ automation_fraction: number | null; automation_percent: number | null }>(
    "SELECT automation_fraction, automation_percent FROM recording_pipeline WHERE external_source_id = 'TEST-009'"
  );
  assert.equal(t9?.automation_fraction, null, "TEST-009 automation stays unknown, never zero-filled");
  assert.equal(t9?.automation_percent, null);
  const order = all<{ external_source_id: string; source_order: number }>(
    "SELECT external_source_id, source_order FROM activities WHERE source_dataset = 'tblActivities' ORDER BY source_order"
  );
  assert.equal(order.length, MASTER_ACTIVITY_ROWS.length);
  const orders = order.map((r) => r.source_order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "source order is preserved");
  assert.equal(new Set(orders).size, orders.length, "source order is unique");
});

test("TEST-labelled records are preserved and flagged for owner confirmation", () => {
  const testRows = get<{ n: number }>("SELECT COUNT(*) AS n FROM recording_pipeline WHERE is_test = 1")?.n ?? 0;
  assert.equal(testRows, 16, "all TEST-labelled pipeline rows are kept, including the source's own TEST labels");
  const needing = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM recording_pipeline WHERE verification_status = 'Needs operational confirmation'"
  )?.n ?? 0;
  assert.ok(needing >= 15, "TEST rows stay flagged until the owner confirms");
  // Import itself never grants confirmation.
  const confirmed = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM recording_pipeline WHERE verification_status = 'Confirmed operational'"
  )?.n ?? 0;
  assert.equal(confirmed, 0);
});

test("unresolved assignee labels are flagged for review, never silently matched", () => {
  const flagged = all<{ source_assignee_text: string; assignee_id: string | null }>(
    "SELECT source_assignee_text, assignee_id FROM activities WHERE source_dataset = 'tblActivities' AND TRIM(COALESCE(source_assignee_text, '')) <> ''"
  );
  const unresolved = flagged.filter((r) => !r.assignee_id);
  assert.ok(unresolved.length > 0, "expected unresolved raw assignee labels to remain visible");
  const labels = new Set(unresolved.map((r) => r.source_assignee_text));
  for (const expected of ["Sudeep/Mukti", "Naweesh", "Tristan", "Sujan"]) {
    assert.ok([...labels].some((l) => l && l.includes(expected)), `unresolved label ${expected} is visible`);
  }
  // No invented people were created from those labels.
  const invented = all<{ name: string }>(
    "SELECT name FROM people WHERE name IN ('Sudeep', 'Mukti', 'Naweesh', 'Tristan', 'Sujan')"
  );
  assert.equal(invented.length, 0, "import must not invent people from raw labels");
  const issues = detectIssues();
  const review = issues.filter((i) => i.rule === "activity.assignment_review");
  assert.ok(review.length > 0, "validation surfaces assignment review warnings");
});

test("pipeline needs_confirmation is reported as info, never as error", () => {
  const issues = detectIssues();
  const needed = issues.filter((i) => i.rule === "pipeline.needs_confirmation");
  assert.ok(needed.length >= 15, "one info issue per TEST-labelled imported record");
  assert.ok(needed.every((i) => i.severity === "info"));
});

test("effective duration subtracts the union of auto overlaps and manual exclusions", () => {
  const qa = [
    { activity: "Regression pack", detail: null, start_date: "2026-07-07", end_date: "2026-07-08" },
  ];
  const item = { activity: "Release rehearsal", planned_start: "2026-07-06", planned_end: "2026-07-10" };
  const base = computeEffectiveDuration(item, qa, []);
  assert.equal(base.weekdays, 5);
  assert.deepEqual(base.blocked_auto_days, ["2026-07-07", "2026-07-08"]);
  assert.equal(base.effective_duration_days, 3);
  assert.equal(base.effective_duration_days, base.weekdays - new Set(base.blocked_union_days).size);

  // Same activity title as the overlapping QA row does not negate the overlap for a *different* QA row,
  // but a matching title row is ignored entirely.
  const matchingQa = [
    { activity: "Release Rehearsal", detail: null, start_date: "2026-07-07", end_date: "2026-07-08" },
  ];
  const matched = computeEffectiveDuration({ ...item, activity: " release REHEARSAL " }, matchingQa, []);
  assert.deepEqual(matched.blocked_auto_days, [], "trim + case-insensitive title match is not a blocker");

  const mixed = [
    { activity: "Release Rehearsal", detail: null, start_date: "2026-07-07", end_date: "2026-07-07" },
    { activity: "Payroll freeze", detail: null, start_date: "2026-07-07", end_date: "2026-07-08" },
  ];
  const mixedResult = computeEffectiveDuration(item, mixed, []);
  assert.deepEqual(mixedResult.blocked_auto_days, ["2026-07-07", "2026-07-08"], "unrelated conflict on the same day still blocks");

  // Manual exclusion deduped against the automatic block (union, not sum).
  const union = computeEffectiveDuration(item, qa, ["2026-07-08", "2026-07-09", "2026-07-09"]);
  assert.deepEqual(union.blocked_union_days, ["2026-07-07", "2026-07-08", "2026-07-09"]);
  assert.equal(union.effective_duration_days, 2);

  // Detail match also suppresses the block.
  const detailMatch = computeEffectiveDuration({ ...item, activity: " Release REHEARSAL " }, [
    { activity: "Regression pack", detail: "release rehearsal", start_date: "2026-07-06", end_date: "2026-07-10" },
  ], []);
  assert.deepEqual(detailMatch.blocked_auto_days, [], "Activity Detail match (trim + case-insensitive) suppresses blocking");

  // Verified holiday configuration removes a weekday and clears the provisional flag.
  const holidaysApplied = computeEffectiveDuration(item, qa, [], { holidays: new Set(["2026-07-10"]) });
  assert.equal(holidaysApplied.weekdays, 4);
  assert.equal(holidaysApplied.effective_duration_days, 2);
  assert.equal(holidaysApplied.holidays_applied, true);
  assert.equal(holidaysApplied.provisional, false);

  // Incomplete ranges yield null duration, never NaN or a wrong number.
  const incomplete = computeEffectiveDuration({ activity: "X", planned_start: "2026-07-06", planned_end: null }, qa, []);
  assert.equal(incomplete.effective_duration_days, null);
  assert.equal(incomplete.weekdays, 0);
});

test("department-scoped administrators are isolated to their own department", () => {
  const org = loadOrg();
  const dept = org.departments.find((d) => d.name === "HFM IT QA");
  const otherDept = org.departments.find((d) => d.name === "Quality Engineering");
  assert.ok(dept, "HFM IT QA department exists after import");
  assert.ok(otherDept, "seeded demo department exists");

  const damien = org.people.find((p) => p.name === "Damien Milthorpe");
  const raheel = org.people.find((p) => p.name === "Raheel Atta");
  assert.ok(damien && raheel, "both source employees are seeded");
  assert.equal(damien!.role, "department_admin");
  assert.equal(scopedDepartmentId(damien! as any), dept!.id);
  assert.equal(raheel!.role, "admin");

  // Department admin sees their department in full, nothing outside it.
  const deptScope = scopeFor(damien!, org);
  assert.deepEqual([...deptScope.departmentIds], [dept!.id]);
  const hfmPeople = new Set(org.people.filter((p) => p.department_id === dept!.id).map((p) => p.id));
  for (const id of deptScope.personIds) {
    assert.ok(hfmPeople.has(id) || id === damien!.id, "department admin sees only own-department people");
  }
  assert.ok(!deptScope.personIds.has(org.people.find((p) => p.department_id === otherDept!.id && p.manager_id !== damien!.id)?.id ?? ""));

  // Permission helpers honour the scope.
  const viewerFor = (person: any, readOnly = false) => {
    const scope = scopeFor(person, org);
    return {
      person,
      actingAs: person,
      previewing: readOnly,
      role: person.role,
      org,
      departmentIds: scope.departmentIds,
      personIds: scope.personIds,
      canSeeAll: scope.isHolistic,
      readOnly,
      activeDepartmentId: null,
      enabledDepartments: org.departments.filter((d) => !!d.enabled),
    } as any;
  };
  const damienViewer = viewerFor(damien);
  const raheelViewer = viewerFor(raheel);
  assert.equal(canAdminDepartment(damienViewer, dept!.id), true);
  assert.equal(canAdminDepartment(damienViewer, otherDept!.id), false);
  assert.equal(canManageDepartment(damienViewer, otherDept!.id), false);
  assert.equal(canAdmin(damienViewer), false, "department admin is not an application administrator");
  assert.equal(canAdmin(raheelViewer), true);

  // Imported HFM people never appear outside their department.
  assert.equal(damien!.department_id, dept!.id);
  assert.equal(raheel!.department_id, dept!.id);
  assert.equal(raheel!.manager_id, damien!.id);
});

test("rollback removes only the imported snapshot and keeps org configuration", () => {
  assert.ok(batchId, "batch id captured from apply");
  const result = rollbackHfmImport(batchId!);
  assert.ok(result.deleted.activities >= EXPECTED_COUNTS.master_activities - 1);
  assert.equal(result.deleted.pipeline, EXPECTED_COUNTS.pending_pipeline);
  assert.equal(result.deleted.exclusions, EXPECTED_COUNTS.manual_exclusions);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE source_dataset = 'tblActivities'")?.n, 0);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM recording_pipeline WHERE source_dataset = 'tblRecordingPipeline'")?.n, 0);
  // Organisation rows and demo data survive rollback.
  const dept = get<{ id: string }>("SELECT id FROM departments WHERE name = 'HFM IT QA'");
  assert.ok(dept, "department is configuration, not rollback scope");
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE name IN ('Damien Milthorpe', 'Raheel Atta')")?.n ?? 0) >= 2);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE is_demo = 1")?.n ?? 0) > 0, "demo data untouched");
});
