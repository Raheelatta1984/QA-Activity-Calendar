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
import { draftEnhancement, suggestEnhancementFields, matchSections } from "../lib/ai";
import { buildDays, dailyFte, demandSeries, headcountFor, quarterBounds, quarterOfMonth } from "../lib/fte";
import { decodeSessionToken, encodeSessionToken } from "../lib/session-token";
import { MIGRATIONS } from "../db/migrations.generated";
import {
  enhancementFileName,
  readEnhancementMarkdown,
  relocateVaultMarkdown,
  removeVaultMarkdown,
  renderEnhancementMarkdown,
  vaultInfo,
  writeVaultMarkdown,
} from "../lib/enhancements";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("session tokens are signed, self-contained and tamper-evident", () => {
  const token = encodeSessionToken({
    s: "sess_abc",
    p: "p_amara",
    e: "2099-01-01T00:00:00.000Z",
    i: null,
  });
  const decoded = decodeSessionToken(token);
  assert.equal(decoded?.p, "p_amara");
  assert.equal(decoded?.s, "sess_abc");

  // Flipping a byte in the payload must invalidate the signature.
  const [body, signature] = token.split(".");
  const tamperedBody = `${body.slice(0, -2)}${body.endsWith("A") ? "B" : "A"}A`;
  assert.equal(decodeSessionToken(`${tamperedBody}.${signature}`), null);

  // Legacy/opaque cookies and malformed values fall back to "no session".
  assert.equal(decodeSessionToken("abc.def"), null);
  assert.equal(decodeSessionToken("no-dot"), null);
});

test("migrations are embedded for serverless bundles", () => {
  assert.ok(MIGRATIONS.length >= 1);
  assert.equal(MIGRATIONS[0].name, "001_init.sql");
  assert.match(MIGRATIONS[0].sql, /CREATE TABLE IF NOT EXISTS activities/i);
  assert.match(MIGRATIONS[0].sql, /CREATE TABLE IF NOT EXISTS tabs/i);
});

/* ------------------------------------------------------------------ FTE calendar */

test("FTE is demanded on every inclusive day of an activity and nowhere else", () => {
  const activity = { start_date: "2026-11-02", end_date: "2026-11-04" };
  assert.equal(dailyFte(activity, 1, "2026-11-01"), 0);
  assert.equal(dailyFte(activity, 1, "2026-11-02"), 1);
  assert.equal(dailyFte(activity, 1, "2026-11-03"), 1);
  assert.equal(dailyFte(activity, 1, "2026-11-04"), 1);
  assert.equal(dailyFte(activity, 1, "2026-11-05"), 0);
  // An unscheduled record can never contribute demand.
  assert.equal(dailyFte({ start_date: null, end_date: "2026-11-04" }, 1, "2026-11-04"), 0);
});

test("overlapping activities sum per day rather than averaging", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04"];
  const active = { active: 1 } as const;
  const series = demandSeries(
    [
      { id: "a", activity: "Regression", start_date: "2026-11-02", end_date: "2026-11-04", effective_fte: 1, activity_group: "Regression", ...active },
      { id: "b", activity: "Automation", start_date: "2026-11-03", end_date: "2026-11-03", effective_fte: 0.5, activity_group: "Automation", ...active },
      { id: "c", activity: "Inactive", start_date: "2026-11-02", end_date: "2026-11-04", effective_fte: 1, activity_group: "Regression", active: 0 },
    ],
    days
  );
  assert.deepEqual(series, [1, 1.5, 1]);
});

test("headcount needed is whole people, never fractions of a person", () => {
  assert.equal(headcountFor(0), 0);
  assert.equal(headcountFor(0.4), 1);
  assert.equal(headcountFor(1), 1);
  assert.equal(headcountFor(1.2), 2); // 1.2 FTE still needs two bodies
  assert.equal(headcountFor(3), 3);
});

test("fiscal quarters start in July and end on the last day of the quarter", () => {
  assert.equal(quarterOfMonth("2026-07"), 1);
  assert.equal(quarterOfMonth("2026-09"), 1);
  assert.equal(quarterOfMonth("2026-10"), 2);
  assert.equal(quarterOfMonth("2026-12"), 2);
  assert.equal(quarterOfMonth("2027-01"), 3);
  assert.equal(quarterOfMonth("2027-06"), 4);
  assert.equal(quarterOfMonth("2027-07"), 1);

  const q1 = quarterBounds("2026-11", 1, 7);
  assert.equal(q1.start, "2026-07-01");
  assert.equal(q1.end, "2026-09-30");
  const q3 = quarterBounds("2026-11", 3, 7);
  assert.equal(q3.start, "2027-01-01");
  assert.equal(q3.end, "2027-03-31");
});

test("FTE calendar days distinguish weekends and supplied holidays", () => {
  const days = buildDays("2026-11-01", "2026-11-30", new Map([["2026-11-10", "Demo holiday"]]), "2026-11-06");
  assert.equal(days.length, 30);
  assert.equal(days[5].date, "2026-11-06");
  assert.equal(days[5].isToday, true);
  // 1 Nov 2026 is a Sunday, 7 Nov is a Saturday, 10 Nov is a supplied holiday.
  assert.equal(days[0].working, false);
  assert.equal(days[6].working, false);
  assert.equal(days[9].working, false);
  assert.equal(days[9].holiday, "Demo holiday");
  // November 2026 has 9 weekend days (5 Sundays, 4 Saturdays) plus the holiday.
  assert.equal(days.filter((d) => d.working).length, 30 - 9 - 1);
});

/* ------------------------------------------------- live enhancement suggestions */

test("the studio drafts options for every field, not a single fixed answer", () => {
  const suggestions = suggestEnhancementFields({
    raw: "Managers need a rolling three-month capacity forecast per department so we can plan contractors before the regression cycle starts.",
    area: "Capacity",
    catalogue: [
      { id: "sec.capacity.pivot", label: "Monthly pivot", tabId: "tab.capacity", tabLabel: "Capacity" },
      { id: "sec.capacity.demand", label: "FTE demand vs capacity", tabId: "tab.capacity", tabLabel: "Capacity" },
      { id: "sec.reporting.bugs", label: "Bug ledger", tabId: "tab.reporting", tabLabel: "Reporting" },
    ],
    departmentName: "Quality Engineering",
    submittedBy: "Amara Okafor",
  });

  for (const field of ["outcome", "title", "brief", "requirements", "impacts", "expectedOutcome", "successCriteria"] as const) {
    assert.ok(suggestions[field].length >= 2, `${field} should offer a choice`);
    assert.ok(suggestions[field].every((option) => option.trim().length > 0), `${field} options must not be blank`);
  }
  assert.ok(suggestions.markdown[0].includes("## Brief"));
  assert.ok(suggestions.markdown[0].includes("Managers need"));
  // Impacted IDs are real catalogue IDs, ranked by relevance to the request.
  assert.match(suggestions.sections[0], /^sec\.capacity\./);
  assert.equal(suggestions.provider, process.env.AI_PROVIDER || "local");
  assert.equal(suggestions.area, "Capacity");
});

test("impact suggestions rank real tab and section IDs against the request", () => {
  const catalogue = [
    { id: "sec.releases.pqu", label: "PQU schedule", tabId: "tab.releases", tabLabel: "Releases" },
    { id: "sec.dashboard.kpis", label: "Headline KPIs", tabId: "tab.dashboard", tabLabel: "Dashboard" },
  ];
  const ranked = matchSections("The release train schedule needs a go/no-go flag", "Releases", catalogue);
  assert.equal(ranked[0]?.id, "sec.releases.pqu");
  assert.deepEqual(matchSections("nothing matches here", undefined, catalogue), []);
  assert.deepEqual(matchSections("anything", undefined, []), []);
});

test("the handover keeps every section heading and never invents an ID", () => {
  const catalogue = [
    { id: "sec.fte.grid", label: "Activity × day matrix", tabId: "tab.fte", tabLabel: "FTE Calendar" },
    { id: "sec.fte.summary", label: "FTE required vs available", tabId: "tab.fte", tabLabel: "FTE Calendar" },
  ];
  const suggestions = suggestEnhancementFields({
    raw: "We need an FTE calendar by activity per day so managers can plan QA testing resource for the month.",
    area: "FTE Calendar",
    catalogue,
  });
  const markdown = suggestions.markdown[0];
  for (const heading of ["## Brief", "## Requirements", "## Impacts", "## Expected outcome", "## Success criteria"]) {
    assert.ok(markdown.includes(heading), `handover is missing ${heading}`);
  }
  // Every suggested ID must exist in the live catalogue — the engine cannot invent one.
  for (const option of suggestions.sections) {
    for (const id of option.split(",").map((value) => value.trim())) {
      assert.ok(
        catalogue.some((entry) => entry.id === id),
        `${id} is not a real section ID`
      );
    }
  }
});

/* ------------------------------------------- serverless & read-only vault */

test("enhancement vault falls back cleanly to /tmp when the configured or bundle path is read-only", () => {
  const prevDir = process.env.ENHANCEMENT_VAULT_DIR;
  const prevVercel = process.env.VERCEL;
  const roDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-vault-ro-"));
  const title = "QA Calendar: Introduce IT Delivery department and move QA department";
  const fileName = enhancementFileName("ENH-0004", title);

  try {
    // Make the directory read-only to reproduce /var/task/enhancements (EROFS/EACCES).
    fs.chmodSync(roDir, 0o555);
    process.env.ENHANCEMENT_VAULT_DIR = roDir;

    const { fileContent } = renderEnhancementMarkdown({
      ref: "ENH-0004",
      title,
      status: "Submitted",
      submittedBy: "Amara Okafor",
      submittedOn: "2026-11-06",
      sections: "sec.setup.departments, sec.setup.hierarchy",
      aiFields: ["title", "brief"],
      brief: "Introduce an IT Delivery parent department and move Quality Engineering underneath it.",
    });

    const written = writeVaultMarkdown({ fileName, content: fileContent });
    assert.equal(written.persistedToDisk, true);
    assert.equal(written.ephemeral, true);
    assert.equal(written.relativePath, `enhancements/${fileName}`);
    assert.ok(written.fullPath?.startsWith(path.join(os.tmpdir(), "enhancements")));
    assert.equal(fs.existsSync(written.fullPath!), true);

    const downloaded = readEnhancementMarkdown({
      ref: "ENH-0004",
      title,
      status: "Submitted",
      github_path: written.relativePath,
    });
    assert.equal(downloaded.filename, fileName);
    assert.match(downloaded.content, /ref: "ENH-0004"/);
    assert.match(downloaded.content, /status: "Submitted"/);

    // Archiving relocates inside the writable fallback without touching the read-only mount.
    const archived = relocateVaultMarkdown({
      githubPath: written.relativePath,
      ref: "ENH-0004",
      title,
      status: "Archived",
      fallbackContent: fileContent,
    });
    assert.equal(archived.relativePath, `enhancements/archive/${fileName}`);
    assert.equal(fs.existsSync(archived.fullPath!), true);
    assert.match(fs.readFileSync(archived.fullPath!, "utf8"), /status: "Archived"/);

    removeVaultMarkdown(archived.relativePath);
    assert.equal(fs.existsSync(archived.fullPath!), false);

    // On Vercel with no explicit override, /tmp/enhancements is selected up front.
    delete process.env.ENHANCEMENT_VAULT_DIR;
    process.env.VERCEL = "1";
    const info = vaultInfo();
    assert.equal(info.serverless, true);
    assert.equal(info.ephemeral, true);
    assert.equal(info.dir, path.join(os.tmpdir(), "enhancements"));
  } finally {
    try {
      fs.chmodSync(roDir, 0o755);
      fs.rmSync(roDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    removeVaultMarkdown(`enhancements/${fileName}`);
    if (prevDir === undefined) delete process.env.ENHANCEMENT_VAULT_DIR;
    else process.env.ENHANCEMENT_VAULT_DIR = prevDir;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }
});

test("readEnhancementMarkdown synthesises frontmatter Markdown when no disk copy exists", () => {
  const result = readEnhancementMarkdown({
    ref: "ENH-0099",
    title: "Cross-instance enhancement download",
    brief: "Ensure downloads still contain YAML frontmatter after a serverless cold start.",
    requirements: "- Serve from DB when /tmp has reset.",
    status: "Reviewing",
    submitted_by_name: "Lachlan Reid",
    ai_fields: JSON.stringify(["title"]),
    created_at: "2026-11-06T10:00:00Z",
  });
  assert.equal(result.filename, "ENH-0099-cross-instance-enhancement-download.md");
  assert.match(result.content, /^---\nref: "ENH-0099"/);
  assert.match(result.content, /submitted_by: "Lachlan Reid"/);
  assert.match(result.content, /ai_fields: "title"/);
  assert.match(result.content, /## Brief/);
});
