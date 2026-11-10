import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `qa-calendar-releases-test-${process.pid}.db`);
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
const { uid } = await import("../lib/ids");
const { loadOrg, scopeFor } = await import("../lib/access");
const {
  RELEASE_GROUP,
  listReleasePlans,
  releaseDemandRows,
  releaseBars,
  releaseFteTotals,
  workingDatesBetween,
  assignablePeople,
  syncReleaseAssignees,
} = await import("../lib/releases");
const { fteCalendar } = await import("../lib/fte");
const { detectIssues } = await import("../lib/validation");

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

/** Fixed, future window so the assertions never depend on "today". */
const WINDOW = { from: "2030-03-04", to: "2030-03-15" }; // Mon → Fri, two working weeks

function createRelease(options: {
  version: string;
  from?: string | null;
  to?: string | null;
  date?: string | null;
  assignees?: Array<[string, number]>;
}) {
  const id = uid("rf");
  run(
    `INSERT INTO release_feed (id, version, kind, date, notes, link, link_verified, department_id, qa_start_date, qa_end_date)
     VALUES (?, ?, 'Self Update', ?, NULL, NULL, 0, 'dept_rel', ?, ?)`,
    id,
    options.version,
    options.date ?? null,
    options.from ?? null,
    options.to ?? null
  );
  for (const [personId, fte] of options.assignees ?? []) {
    run(
      `INSERT INTO release_assignees (id, release_id, person_id, role, fte) VALUES (?, ?, ?, 'QA', ?)`,
      uid("rla"),
      id,
      personId,
      fte
    );
  }
  return id;
}

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

test("working days exclude weekends", () => {
  const days = workingDatesBetween(WINDOW.from, WINDOW.to);
  assert.equal(days.length, 10); // 2030-03-04 is a Monday, 2030-03-15 a Friday
  assert.ok(days.every((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 0));
  assert.ok(days.every((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 6));
});

test("release plan derives FTE-days from the window and the assignee shares", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  createRelease({ version: "T-100.1", from: WINDOW.from, to: WINDOW.to, assignees: [["p_sofia", 0.6], ["p_tom", 0.4]] });

  const plan = listReleasePlans(admin, { includeUnplanned: true }).find((item) => item.version === "T-100.1")!;
  assert.ok(plan, "the new release is visible");
  assert.equal(plan.status, "Scheduled");
  assert.equal(plan.working_days, 10);
  assert.equal(plan.calendar_days, 12);
  assert.equal(plan.fte_per_day, 1);
  assert.equal(plan.fte_days, 10);
  assert.equal(plan.assignee_count, 2);
  assert.equal(plan.warnings.length, 0);
  // Hours follow the configured hours-per-day (7.6 default), never a hard-coded 8.
  assert.equal(plan.hours, Math.round(10 * 7.6 * 100) / 100);
});

test("a window without assignees is a visible gap, not zero effort that looks planned", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  createRelease({ version: "T-100.2", from: "2030-04-01", to: "2030-04-05" });

  const plan = listReleasePlans(admin, { includeUnplanned: true }).find((item) => item.version === "T-100.2")!;
  assert.equal(plan.fte_days, 0);
  assert.equal(plan.assignee_count, 0);
  assert.ok(plan.warnings.some((warning) => /no assignees/i.test(warning)));

  const rows = releaseDemandRows(admin, "2030-04-01", "2030-04-05");
  const unassigned = rows.filter((row) => row.version === "T-100.2");
  assert.equal(unassigned.length, 1);
  assert.equal(unassigned[0].assignee_id, null);
  assert.equal(unassigned[0].assignee_name, "Unassigned");
});

test("an invalid or missing window is reported rather than guessed", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  createRelease({ version: "T-100.3", from: "2030-05-10", to: "2030-05-01" });
  createRelease({ version: "T-100.4" });

  const plans = listReleasePlans(admin, { includeUnplanned: true });
  const reversed = plans.find((item) => item.version === "T-100.3")!;
  const unplanned = plans.find((item) => item.version === "T-100.4")!;
  assert.equal(reversed.status, "Invalid window");
  assert.equal(reversed.fte_days, 0);
  assert.equal(unplanned.status, "No window");
  assert.ok(unplanned.warnings.length > 0);
});

test("release demand produces one row per assignee, keyed to the release window", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const rows = releaseDemandRows(admin, WINDOW.from, WINDOW.to).filter((row) => row.version === "T-100.1");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.assignee_name).sort(),
    ["Sofia Marchetti", "Tom Nguyen"]
  );
  for (const row of rows) {
    assert.equal(row.group, RELEASE_GROUP);
    assert.equal(row.start_date, WINDOW.from);
    assert.equal(row.end_date, WINDOW.to);
    assert.ok(row.id.startsWith("rel:"));
  }
  assert.equal(rows.reduce((sum, row) => sum + row.fte, 0), 1);
});

test("the QA calendar receives a bar per scheduled release window", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const bars = releaseBars(admin, WINDOW.from, WINDOW.to);
  const bar = bars.find((item) => item.version === "T-100.1")!;
  assert.ok(bar);
  assert.equal(bar.start_date, WINDOW.from);
  assert.equal(bar.end_date, WINDOW.to);
  assert.equal(bar.fte_days, 10);
  assert.equal(bar.assignee_ids.length, 2);
  assert.ok(bar.assignee_names.includes("Sofia"));
});

test("the FTE calendar includes release demand in the matrix, daily totals and roll-ups", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const month = WINDOW.from.slice(0, 7);
  const withReleases = fteCalendar(admin, { monthKey: month, range: "month", includeReleases: true });
  const without = fteCalendar(admin, { monthKey: month, range: "month", includeReleases: false });

  const releaseRows = withReleases.rows.filter((row) => row.kind === "release" && row.activity.includes("T-100.1"));
  assert.equal(releaseRows.length, 2);
  assert.equal(withReleases.totals.releases, releaseRows.length);
  assert.equal(withReleases.totals.release_fte_days, 10);

  // Removing release rows must lower (or keep) the daily totals — never raise them.
  assert.ok(withReleases.totals.fte_days_working >= without.totals.fte_days_working);
  const dayIndex = withReleases.days.findIndex((day) => day.date === "2030-03-05" && day.working);
  assert.ok(dayIndex >= 0);
  assert.equal(
    Math.round((withReleases.daily_totals[dayIndex] - without.daily_totals[dayIndex]) * 100) / 100,
    1
  );

  // Per-assignee rollups carry the release FTE too.
  const sofia = withReleases.by_assignee.find((entry) => entry.name === "Sofia Marchetti");
  assert.ok(sofia, "Sofia has demand in the month");
  assert.ok(sofia!.fte_days > 0);

  // The matrix can be narrowed to release work only.
  const releaseOnly = fteCalendar(admin, { monthKey: month, group: "Release" });
  assert.ok(releaseOnly.rows.length > 0);
  assert.ok(releaseOnly.rows.every((row) => row.group === "Release"));
});

test("release totals add up across releases", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const plans = listReleasePlans(admin, { includeUnplanned: true });
  const totals = releaseFteTotals(plans);
  assert.equal(totals.releases, plans.length);
  assert.equal(
    totals.fte_days,
    Math.round(plans.filter((plan) => plan.scheduled).reduce((sum, plan) => sum + plan.fte_days, 0) * 100) / 100
  );
  assert.ok(totals.unassigned >= 1);
  assert.ok(totals.assignees >= 2);
});

test("release-planning gaps reach the validation queue", () => {
  const issues = detectIssues();
  const rules = new Set(issues.map((issue) => issue.rule));
  assert.ok(rules.has("release.qa_window_unassigned"), "unassigned window is a warning");
  assert.ok(rules.has("release.qa_window_invalid"), "reversed window is an error");
  assert.ok(rules.has("release.qa_window_missing"), "missing window is an info item");
});

test("assignable people exclude inactive accounts and respect visibility", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const people = assignablePeople(admin);
  assert.ok(people.length > 0);
  const org = loadOrg();
  const inactive = new Set(org.people.filter((person) => !person.active).map((person) => person.id));
  assert.ok(people.every((person) => !inactive.has(person.id)), "inactive accounts are not assignable");
  const viewer = viewerFor("hana.suzuki@hfm.demo");
  const narrow = assignablePeople(viewer);
  assert.ok(narrow.every((person) => viewer.personIds.has(person.id)));
});

test("deleting a release removes its assignees (no orphan FTE rows)", () => {
  const admin = viewerFor("amara.okafor@hfm.demo");
  const id = createRelease({ version: "T-100.9", from: "2030-06-03", to: "2030-06-07", assignees: [["p_hana", 0.5]] });
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM release_assignees WHERE release_id = ?`, id)?.n, 1);
  run(`DELETE FROM release_feed WHERE id = ?`, id);
  assert.equal(
    all<{ id: string }>(`SELECT id FROM release_assignees WHERE release_id = ?`, id).length,
    0,
    "assignees cascade with the release"
  );
  assert.equal(listReleasePlans(admin, { includeUnplanned: true }).some((plan) => plan.id === id), false);
});

test("saving a plan preserves assignees that are outside the editor's scope", () => {
  // Only p_sofia is in this editor's visibility scope. Re-saving the window must
  // not delete p_tom's existing assignment — narrow scope is not a delete order.
  const id = createRelease({
    version: "T-101.0",
    from: WINDOW.from,
    to: WINDOW.to,
    assignees: [["p_sofia", 0.6], ["p_tom", 0.4]],
  });

  syncReleaseAssignees(id, new Set(["p_sofia"]), [{ person_id: "p_sofia", fte: 0.6 }]);

  const rows = all<{ person_id: string; fte: number }>(
    `SELECT person_id, fte FROM release_assignees WHERE release_id = ? ORDER BY person_id`,
    id
  );
  assert.deepEqual(rows.map((row) => row.person_id), ["p_sofia", "p_tom"]);
  assert.equal(rows.find((row) => row.person_id === "p_tom")!.fte, 0.4, "out-of-scope share is untouched");
});

test("unticking an in-scope assignee removes exactly that row and updates the rest", () => {
  const id = createRelease({
    version: "T-101.1",
    from: WINDOW.from,
    to: WINDOW.to,
    assignees: [["p_sofia", 0.6], ["p_tom", 0.4]],
  });

  syncReleaseAssignees(
    id,
    new Set(["p_sofia", "p_tom"]),
    [{ person_id: "p_tom", fte: 0.8 }]
  );

  const rows = all<{ person_id: string; fte: number }>(
    `SELECT person_id, fte FROM release_assignees WHERE release_id = ? ORDER BY person_id`,
    id
  );
  assert.deepEqual(rows, [{ person_id: "p_tom", fte: 0.8 }], "removed, updated, no duplicates");

  const admin = viewerFor("amara.okafor@hfm.demo");
  const plan = listReleasePlans(admin, { includeUnplanned: true }).find((item) => item.id === id)!;
  assert.equal(plan.fte_per_day, 0.8);
  assert.equal(plan.fte_days, 8); // 0.8 × 10 working days
});
