import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMonthGrid,
  fiscalQuarters,
  fiscalYearBounds,
  fiscalYearOf,
  inclusiveDays,
  isValidRange,
  addDays,
  sourceDeploymentDate,
  isWeekend,
  eachDay,
} from "../lib/dates";
import { fteFromHours, resolveFte } from "../lib/activities";
import { effectiveRange } from "../lib/pipeline";
import { deriveStatus } from "../lib/bugs";
import { descendantsOf, scopeFor, type Org } from "../lib/access";
import { draftEnhancement } from "../lib/ai";

test("FY27 runs July 2026 to June 2027", () => {
  const nov = fiscalYearOf("2026-11-06");
  assert.equal(nov.label, "FY27");
  const bounds = fiscalYearBounds(nov.startYear);
  assert.equal(bounds.start, "2026-07-01");
  assert.equal(bounds.end, "2027-06-30");
  // June 2027 belongs to FY27, July 2027 belongs to FY28.
  assert.equal(fiscalYearOf("2027-06-30").label, "FY27");
  assert.equal(fiscalYearOf("2027-07-01").label, "FY28");
});

test("quarters are ordered Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun", () => {
  const quarters = fiscalQuarters(2026);
  assert.equal(quarters.length, 4);
  assert.equal(quarters[0].start, "2026-07-01");
  assert.equal(quarters[0].end, "2026-09-30");
  assert.equal(quarters[1].start, "2026-10-01");
  assert.equal(quarters[2].start, "2027-01-01");
  assert.equal(quarters[3].end, "2027-06-30");
});

test("dates are inclusive and ranges are validated", () => {
  assert.equal(inclusiveDays("2026-11-06", "2026-11-06"), 1);
  assert.equal(inclusiveDays("2026-11-01", "2026-11-30"), 30);
  assert.equal(isValidRange("2026-11-06", "2026-11-06"), true);
  assert.equal(isValidRange("2026-11-07", "2026-11-06"), false);
  assert.equal(isValidRange("2026-13-01", "2026-12-01"), false);
});

test("month grid starts on Monday and excludes weekends/holidays from working days", () => {
  const grid = buildMonthGrid("2026-11", { today: "2026-11-06", holidays: new Map([["2026-11-10", "Demo holiday"]]) });
  for (const week of grid.weeks) assert.equal(week.length, 7);
  assert.equal(grid.weeks[0][0].weekday, 0);
  // November 2026 has 21 weekdays; one supplied holiday reduces working days to 20.
  assert.equal(grid.workingDays, 20);
  const holiday = grid.weeks.flat().find((day) => day.date === "2026-11-10");
  assert.equal(holiday?.isHoliday, true);
  const today = grid.weeks.flat().find((day) => day.date === "2026-11-06");
  assert.equal(today?.isToday, true);
  assert.equal(today?.isCurrentWeek, true);
  assert.equal(isWeekend("2026-11-07"), true);
  assert.equal(isWeekend("2026-11-09"), false);
});

const settingsStub = {
  fiscalStartMonth: 7,
  hoursPerDay: 7.6,
  fteRegression: 1,
  fteDefault: 0.5,
  includeUnavailable: true,
  appName: "test",
  timezone: "Australia/Sydney",
  blockingRule: "active-qa-overlap",
  visibilityRule: "subtree-downward",
};

test("FTE defaults follow Regression=1, otherwise 0.5, with explicit override winning", () => {
  assert.equal(resolveFte({ activity_group: "Regression", fte: 0.5, fte_override: null }, settingsStub), 1);
  assert.equal(resolveFte({ activity_group: "Automation", fte: 0.5, fte_override: null }, settingsStub), 0.5);
  assert.equal(resolveFte({ activity_group: "Regression", fte: 1, fte_override: 0.25 }, settingsStub), 0.25);
});

test("hours convert to FTE without inventing an 8-hour default", () => {
  assert.equal(fteFromHours(4, 8), 0.5);
  assert.equal(fteFromHours(4, 7.6), 0.53);
  assert.equal(fteFromHours(7.6, 7.6), 1);
  assert.equal(fteFromHours(0, 7.6), 0);
});

test("pipeline duration uses the later planned/actual start and later end", () => {
  const range = effectiveRange({
    planned_start: "2026-11-02",
    planned_end: "2026-11-10",
    actual_start: "2026-11-04",
    actual_end: "2026-11-06",
  });
  assert.equal(range.start, "2026-11-04");
  assert.equal(range.end, "2026-11-10");
  assert.equal(range.duration, 7);

  const noActual = effectiveRange({
    planned_start: "2026-11-02",
    planned_end: null,
    actual_start: null,
    actual_end: null,
  });
  assert.equal(noActual.end, null);
  assert.equal(noActual.duration, null);
});

test("shared bug stays open while any service link is outstanding", () => {
  assert.equal(
    deriveStatus("Open", [
      { service_id: "a", service_name: "Core", status: "Closed" },
      { service_id: "b", service_name: "Web", status: "Fixed" },
    ]),
    "Fixed"
  );
  assert.equal(
    deriveStatus("Open", [
      { service_id: "a", service_name: "Core", status: "Closed" },
      { service_id: "b", service_name: "Web", status: "Open" },
    ]),
    "Open"
  );
  assert.equal(
    deriveStatus("Open", [
      { service_id: "a", service_name: "Core", status: "Closed" },
      { service_id: "b", service_name: "Web", status: "Closed" },
    ]),
    "Closed"
  );
});

test("deployment plan reproduces start + weeks*6 then workday adjustment", () => {
  // 2026-11-06 is a Friday; +12 days is Wednesday 18 Nov → unchanged.
  assert.equal(sourceDeploymentDate("2026-11-06", 2), "2026-11-18");
  // Landing on a Saturday shifts to the next working day.
  assert.equal(sourceDeploymentDate("2026-11-02", 2), "2026-11-16");
  // A holiday on the candidate day also shifts forward.
  assert.equal(sourceDeploymentDate("2026-11-06", 2, new Set(["2026-11-18"])), "2026-11-19");
});

function makeOrg(): Org {
  const people = [
    { id: "p_priya", name: "Priya", role: "exec", manager_id: null, department_id: "d1" },
    { id: "p_amara", name: "Amara", role: "admin", manager_id: "p_priya", department_id: "d1" },
    { id: "p_lachlan", name: "Lachlan", role: "manager", manager_id: "p_amara", department_id: "d1" },
    { id: "p_sofia", name: "Sofia", role: "editor", manager_id: "p_lachlan", department_id: "d1" },
    { id: "p_tom", name: "Tom", role: "editor", manager_id: "p_lachlan", department_id: "d1" },
  ].map((p) => ({
    ...p,
    email: `${p.id}@demo`,
    title: null,
    capacity_hours_day: 7.6,
    colour: "#888",
    active: 1,
    is_demo: 0,
  }));
  const departments = [
    { id: "d1", company_id: "c1", code: "QA", name: "QA", description: null, colour: "#4f8cff", enabled: 1, sort_order: 1 },
    { id: "d2", company_id: "c1", code: "PAY", name: "Paused", description: null, colour: "#f00", enabled: 0, sort_order: 2 },
  ];
  return {
    company: { id: "c1", name: "HFM", legal_name: null, timezone: "Australia/Sydney", fiscal_start_month: 7 },
    departments,
    people: people as any,
    byId: new Map(people.map((p) => [p.id, p as any])),
    deptById: new Map(departments.map((d) => [d.id, d])),
  };
}

test("visibility is downward-only and excludes disabled departments", () => {
  const org = makeOrg();
  const amara = org.byId.get("p_amara")!;
  const amaraTree = descendantsOf(org.people, amara.id);
  assert.deepEqual([...amaraTree].sort(), ["p_amara", "p_lachlan", "p_sofia", "p_tom"]);
  assert.equal(amaraTree.has("p_priya"), false);

  const sofiaScope = scopeFor(org.byId.get("p_sofia")!, org);
  assert.deepEqual([...sofiaScope.personIds], ["p_sofia"]);
  // Disabled department removed from operational scope.
  assert.deepEqual([...sofiaScope.departmentIds], ["d1"]);

  const execScope = scopeFor(org.byId.get("p_priya")!, org);
  assert.equal(execScope.isHolistic, true);
  assert.equal(execScope.personIds.size, 5);
});

test("AI enhancement draft is structured and deterministic", () => {
  const draft = draftEnhancement({
    raw: "Managers need a rolling three-month capacity forecast per department so we can plan contractors. It should export to CSV and respect weekends.",
  });
  assert.ok(draft.title.length > 10);
  assert.match(draft.requirements, /^- /m);
  assert.match(draft.impacts, /Capacity/i);
  assert.ok(draft.successCriteria.includes("role model"));
  assert.equal(draft.provider, process.env.AI_PROVIDER || "local");
});

test("eachDay never loops past a reversed range", () => {
  assert.deepEqual(eachDay("2026-11-06", "2026-11-05"), []);
  const days = eachDay("2026-11-06", "2026-11-08");
  assert.equal(days.length, 3);
  assert.equal(addDays(days[2], 1), "2026-11-09");
});
