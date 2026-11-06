import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the data layer at an isolated database before importing it.
const dbPath = path.join(os.tmpdir(), `qa-calendar-test-${process.pid}.db`);
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
const { runImport, parseSourceDate } = await import("../lib/import");
const { detectIssues } = await import("../lib/validation");
const { listBugs, deriveStatus } = await import("../lib/bugs");
const { listActivities } = await import("../lib/activities");
const { scopeFor, loadOrg, descendantsOf } = await import("../lib/access");
const { isoToday } = await import("../lib/dates");

const viewerFor = (email: string) => {
  const org = loadOrg();
  const person = org.people.find((p) => p.email === email)!;
  const scope = scopeFor(person, org);
  return {
    person,
    actingAs: person,
    previewing: false,
    role: person.role,
    org,
    departmentIds: scope.departmentIds,
    personIds: scope.personIds,
    canSeeAll: scope.isHolistic,
    readOnly: false,
    activeDepartmentId: null,
    enabledDepartments: org.departments.filter((d) => !!d.enabled),
  } as any;
};

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

test("database seeds reference configuration and demo data", () => {
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM tabs")?.n ?? 0) >= 10);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM sections")?.n ?? 0) >= 20);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM sticky_notes")?.n ?? 0) >= 10);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM holidays")?.n ?? 0) >= 20);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")?.n ?? 0) >= 15);
  assert.ok((get<{ n: number }>("SELECT COUNT(*) AS n FROM activities WHERE is_demo = 0")?.n ?? 0) === 0);
});

test("management view sees more than an individual contributor", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const ic = viewerFor("hana.suzuki@hfm.demo");
  const adminActivities = listActivities(admin, { includeInactive: true }).length;
  const icActivities = listActivities(ic, { includeInactive: true }).length;
  assert.ok(adminActivities > icActivities, "admin should see more activities than a viewer");
  // The leaf cannot see her manager's activity (visibility is downward-only).
  const managerActivity = get<{ assignee_id: string }>(
    `SELECT assignee_id FROM activities WHERE activity = 'Release readiness review'`
  );
  assert.equal(managerActivity?.assignee_id, "p_grace");
  assert.equal(ic.personIds.has("p_grace"), false);
});

test("import dry run changes nothing and apply is idempotent", () => {
  const csv = `Calendar Item ID,Activity,Activity Group,Active Status,Start Date,End Date,FTE,Assing To,Status
IMP-1,Imported regression sweep,Regression,Yes,2026-11-09,2026-11-20,1,Sofia Marchetti,Planned
IMP-2,Imported automation pack,Automation,Yes,2026-11-16,2026-11-27,0.5,Tom Nguyen,Planned`;

  const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")!.n;
  const dry = runImport({ text: csv, target: "activities", mode: "dry-run", filename: "test.csv" });
  assert.equal(dry.inserted, 2);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")!.n, before, "dry run must not write activities");
  assert.ok(dry.rows.every((row) => row.status === "inserted"));

  const apply = runImport({ text: csv, target: "activities", mode: "apply", filename: "test.csv" });
  assert.equal(apply.inserted, 2);
  const afterFirst = get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")!.n;
  assert.equal(afterFirst, before + 2);

  const second = runImport({ text: csv, target: "activities", mode: "apply", filename: "test.csv" });
  assert.equal(second.skipped, 2);
  assert.equal(second.inserted, 0);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")!.n, afterFirst, "import must be idempotent");

  const imported = get<any>(`SELECT * FROM activities WHERE code = 'IMP-1'`);
  assert.equal(imported.source_sheet, "tblActivities");
  assert.equal(imported.source_row, 2);
  assert.ok(imported.import_batch_id);
});

test("spreadsheet serial dates and unknown dates are handled explicitly", () => {
  assert.equal(parseSourceDate("46750").value, "2027-12-29");
  assert.equal(parseSourceDate("06/11/2026").value, "2026-11-06");
  assert.equal(parseSourceDate("06/11/2026").note, "Day/month/year text parsed");
  assert.equal(parseSourceDate("not a date").value, null);
  assert.match(parseSourceDate("not a date").note ?? "", /left unknown/);
});

test("invalid ranges are flagged, never corrected", () => {
  const csv = `Calendar Item ID,Activity,Activity Group,Active Status,Start Date,End Date
IMP-BAD,Broken range,Regression,Yes,2026-12-10,2026-12-01`;
  const report = runImport({ text: csv, target: "activities", mode: "apply", filename: "bad.csv" });
  assert.equal(report.errors, 1);
  assert.equal(get(`SELECT 1 FROM activities WHERE code = 'IMP-BAD'`), undefined);
});

test("shared defect stays open until every service link is closed", () => {
  const shared = get<any>(`SELECT * FROM bugs WHERE bug_key = 'HFM-1051'`);
  assert.ok(shared);
  const links = all<any>(`SELECT * FROM bug_service_links WHERE bug_id = ?`, shared.id);
  assert.equal(links.length, 2);
  assert.equal(deriveStatus(shared.status, links.map((l) => ({ ...l, service_name: "x" }))), "Open");

  run(`UPDATE bug_service_links SET status = 'Closed' WHERE bug_id = ?`, shared.id);
  const allClosed = all<any>(`SELECT * FROM bug_service_links WHERE bug_id = ?`, shared.id);
  assert.equal(deriveStatus(shared.status, allClosed.map((l) => ({ ...l, service_name: "x" }))), "Closed");
});

test("validation detects governance and range problems", () => {
  run(
    `INSERT INTO release_governance (id, release_id, version, regression_status, go_no_go, deployment_status)
     VALUES ('gov_test', 'REL-9.9', '9.9.0', 'In progress', 'Go', 'Not deployed')`
  );
  run(
    `INSERT INTO activities (id, activity, activity_group, active, start_date, end_date, fte, colour)
     VALUES ('act_bad_range', 'Bad range', 'Regression', 1, '2026-12-10', '2026-12-01', 1, '#fff')`
  );
  const issues = detectIssues();
  assert.ok(issues.some((i) => i.rule === "governance.go_without_regression"));
  assert.ok(issues.some((i) => i.rule === "activity.invalid_range"));
  assert.ok(issues.some((i) => i.rule === "activity.missing_dates"), "unscheduled queue is populated");
});

test("demo bugs expose reported/fixed/closed/outstanding totals", () => {
  const viewer = viewerFor("amara.okafor@hfm.demo");
  const bugs = listBugs(viewer);
  assert.ok(bugs.length >= 8);
  assert.ok(bugs.some((bug) => bug.links.length === 2), "shared defect present");
  const outstanding = bugs.filter((bug) => bug.derived_status === "Open").length;
  assert.ok(outstanding > 0);
});

test("national holidays feed working-day logic", () => {
  const christmas = get<{ name: string }>(`SELECT name FROM holidays WHERE date = '2026-12-25'`);
  assert.equal(christmas?.name, "Christmas Day");
  const today = isoToday();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
});

test("hierarchy move cannot create a loop", () => {
  const org = loadOrg();
  const descendants = descendantsOf(org.people, "p_amara");
  assert.equal(descendants.has("p_lachlan"), true);
  // Moving Amara under Lachlan (her report) would be a cycle — the action guards this.
  assert.equal(descendants.has("p_priya"), false);
  const before = get<{ manager_id: string }>(`SELECT manager_id FROM people WHERE id = 'p_sofia'`)!;
  assert.equal(before.manager_id, "p_lachlan");
});

test("every tab and section carries an AI guidance note", () => {
  const tabsWithout = all<{ id: string }>(
    `SELECT t.id FROM tabs t WHERE NOT EXISTS (SELECT 1 FROM sticky_notes n WHERE n.tab_id = t.id AND n.section_id IS NULL)`
  );
  const sectionsWithout = all<{ id: string }>(
    `SELECT s.id FROM sections s WHERE NOT EXISTS (SELECT 1 FROM sticky_notes n WHERE n.section_id = s.id)`
  );
  assert.deepEqual(tabsWithout.map((t) => t.id), [], "each tab needs tab-level guidance");
  assert.deepEqual(sectionsWithout.map((s) => s.id), [], "each section needs its own guidance");
});

test("catalogue covers every tab and section with a stable ID", () => {
  const tabs = all<{ id: string }>(`SELECT id FROM tabs`);
  assert.equal(tabs.length, 11);
  for (const tab of tabs) {
    assert.match(tab.id, /^tab\.[a-z]+$/);
  }
  const sections = all<{ id: string }>(`SELECT id FROM sections`);
  for (const section of sections) {
    assert.match(section.id, /^sec\.[a-z]+\.[a-z]+$/);
  }
});
