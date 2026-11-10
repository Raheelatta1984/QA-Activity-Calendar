import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated database: multi-tenant isolation, reversible injection and the
// project-name field are all exercised against real SQLite migrations.
const dbPath = path.join(os.tmpdir(), `qa-calendar-tenancy-${process.pid}.db`);
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
const { runHfmImport } = await import("../lib/hfm-import");
const { listCompanies, listEntities, listLoginAccounts } = await import("../lib/org");
const { loadOrg, scopeFor, departmentScope } = await import("../lib/access");
const { listActivities } = await import("../lib/activities");
const { listPipeline } = await import("../lib/pipeline");
const { listReleasePlans } = await import("../lib/releases");
const { listBugs } = await import("../lib/bugs");
const { fteCalendar } = await import("../lib/fte");
const { toClientActivity } = await import("../lib/serialize");
const {
  defaultSourceCompanyId,
  defaultTargetCompanyId,
  previewTenantInjection,
  injectTenantData,
  deleteTenantInjection,
  listInjectionBatches,
} = await import("../lib/tenant-injection");
const { HARRISFARM_TENANT, ensureHarrisfarmMarketsTenant } = await import("../lib/tenants");

const HFM = () => listCompanies().find((company) => company.code === "HFM")!;
const HFM2 = () => listCompanies().find((company) => company.code === "HFM2")!;
const DEMO = () => listCompanies().find((company) => company.name === "HFM")!;

function viewerFor(companyId: string, personId: string, selectedDepartments: string[] = []) {
  const org = loadOrg(companyId);
  const person = org.people.find((candidate) => candidate.id === personId)!;
  assert.ok(person, `person ${personId} exists in ${org.company.name}`);
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
    activeDepartmentId: selectedDepartments.length === 1 ? selectedDepartments[0] : null,
    activeDepartmentIds: selectedDepartments,
    enabledDepartments: org.departments.filter((department) => !!department.enabled),
    companies: listCompanies().filter((company) => company.id === companyId),
    selectedEntityId: null,
    entities: listEntities(companyId),
  } as any;
}

before(() => {
  bootstrapDatabase();
  const report = runHfmImport({ apply: true, requestedBy: "Tenancy test" });
  if (report.errors.length) throw new Error(`HFM import failed: ${report.errors.join("; ")}`);
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

test("Harrisfarm Markets is a separate third tenant with its own entity and identities", () => {
  const companies = listCompanies();
  assert.equal(companies.length, 3);
  const hfm = HFM();
  const target = HFM2();
  assert.notEqual(hfm.id, target.id);
  assert.equal(target.name, "Harrisfarm Markets");
  assert.equal(target.code, "HFM2");
  assert.equal(target.is_default, 0);
  assert.equal(hfm.is_default, 1);
  assert.equal(target.entity_count, 1);

  const org = loadOrg(target.id);
  assert.equal(listEntities(target.id).length, 1);
  assert.equal(listEntities(target.id)[0].name, "Harrisfarm Markets");
  assert.ok(org.departments.every((department) => department.company_id === target.id));
  assert.deepEqual(
    org.people.map((person) => person.name).sort(),
    ["Damien Milthorpe", "Raheel Atta"]
  );
  const damien = org.people.find((person) => person.name === "Damien Milthorpe")!;
  const raheel = org.people.find((person) => person.name === "Raheel Atta")!;
  assert.equal(damien.role, "department_admin");
  assert.equal(raheel.role, "admin");
  assert.equal(damien.email, null, "no email is invented for a tenant identity");
  assert.equal(raheel.email, null, "no duplicate email is stored");
  assert.ok(damien.linked_person_id, "Damien's tenant identity links to the HFM account");
  assert.ok(raheel.linked_person_id, "Raheel's tenant identity links to the HFM account");
  const hfmRaheel = loadOrg(hfm.id).people.find((person) => person.name === "Raheel Atta")!;
  assert.equal(raheel.linked_person_id, hfmRaheel.id);
  assert.equal(hfmRaheel.email, "ratta@harrisfarm.com.au", "the original HFM identity is unchanged");
});

test("creating the tenant twice is idempotent", () => {
  const beforeCompanies = listCompanies().length;
  const beforeDepartments = loadOrg(HFM2().id).departments.length;
  ensureHarrisfarmMarketsTenant({ name: "test" });
  assert.equal(listCompanies().length, beforeCompanies);
  assert.equal(loadOrg(HFM2().id).departments.length, beforeDepartments);
  assert.equal(loadOrg(HFM2().id).people.length, 2);
});

test("login roster shows linked identities without copying credentials", () => {
  const scope = listLoginAccounts(HFM2().id);
  assert.deepEqual(scope.accounts.map((account) => account.name).sort(), ["Damien Milthorpe", "Raheel Atta"]);
  for (const account of scope.accounts) {
    assert.equal(account.has_login, 0, "the tenant copy has no password of its own");
    assert.equal(account.email, null);
    assert.ok(account.linked_person_id, "the tenant copy links to an HFM identity");
  }
  const raheel = scope.accounts.find((account) => account.name === "Raheel Atta")!;
  const damien = scope.accounts.find((account) => account.name === "Damien Milthorpe")!;
  assert.equal(raheel.linked_email, "ratta@harrisfarm.com.au", "the linked HFM email is offered for sign-in");
  assert.equal(damien.linked_email, null, "no email is invented for Damien's linked identity");
});

test("each tenant's operational reads are isolated before any copy", () => {
  const hfmViewer = viewerFor(HFM().id, loadOrg(HFM().id).people.find((p) => p.name === "Raheel Atta")!.id);
  const targetViewer = viewerFor(HFM2().id, "p_hfm2_raheel");
  assert.ok(listActivities(hfmViewer, { includeInactive: true }).length >= 52);
  assert.equal(listActivities(targetViewer).length, 0);
  assert.ok(listPipeline(hfmViewer).length > 0);
  assert.equal(listPipeline(targetViewer).length, 0);
  assert.equal(listReleasePlans(targetViewer).length, 0);
  assert.equal(listBugs(targetViewer).length, 0);
  assert.equal(fteCalendar(targetViewer, { monthKey: new Date().toISOString().slice(0, 7) }).rows.length, 0);
});

test("project names are persisted, serialised and searchable", () => {
  const hfm = HFM();
  const row = get<{ id: string }>(`SELECT id FROM activities WHERE company_id = ? ORDER BY id LIMIT 1`, hfm.id)!;
  run(`UPDATE activities SET project_name = 'Store Stock Shipment' WHERE id = ?`, row.id);
  const viewer = viewerFor(hfm.id, loadOrg(hfm.id).people.find((p) => p.name === "Raheel Atta")!.id);
  const activity = listActivities(viewer, { includeInactive: true }).find((item) => item.id === row.id)!;
  assert.equal(activity.project_name, "Store Stock Shipment");
  assert.equal(toClientActivity(activity).project_name, "Store Stock Shipment");
  assert.ok(
    listActivities(viewer, { includeInactive: true, search: "store stock" }).some((item) => item.id === row.id),
    "the calendar/report search includes the project name"
  );
});

test("selecting two departments narrows work and people without losing either", () => {
  const demo = DEMO();
  const org = loadOrg(demo.id);
  const admin = org.people.find((person) => person.role === "admin")!;
  const selected = org.departments.filter((department) => ["dept_qa", "dept_rel"].includes(department.id));
  assert.equal(selected.length, 2);
  const viewer = viewerFor(demo.id, admin.id, selected.map((department) => department.id));
  assert.deepEqual([...departmentScope(viewer)].sort(), selected.map((department) => department.id).sort());
  const activities = listActivities(viewer);
  assert.ok(activities.length > 0);
  assert.ok(
    activities.every((activity) => selected.some((department) => department.id === activity.department_id)),
    "no work from an unselected department is shown"
  );
  const fte = fteCalendar(viewer, { monthKey: new Date().toISOString().slice(0, 7) });
  assert.ok(fte.by_assignee.length > 0);
  assert.ok(
    fte.rows.every((row) => row.kind === "release" || selected.some((department) => department.id === row.department_id)),
    "no row from an unselected department is shown"
  );
  const allViewer = viewerFor(demo.id, admin.id);
  assert.ok(listActivities(allViewer).length > activities.length, "clearing the selection reveals more departments");
});

test("copying HFM data tags every copy, assigns Raheel and leaves the source untouched", () => {
  const source = defaultSourceCompanyId();
  const target = defaultTargetCompanyId();
  assert.equal(source, HFM().id);
  assert.equal(target, HFM2().id);
  const sourceActivities = all<{ id: string; assignee_id: string | null }>(
    `SELECT id, assignee_id FROM activities WHERE company_id = ? ORDER BY id`,
    source
  );
  const sourcePipeline = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?`, source)!.n;
  const preview = previewTenantInjection({ sourceCompanyId: source, targetCompanyId: target });
  assert.ok(preview.tables.find((table) => table.label === "Activities")!.count >= 52);

  const result = injectTenantData({ sourceCompanyId: source, targetCompanyId: target, actorName: "test" });
  assert.equal(result.reused, false);
  assert.equal(result.counts.activities, sourceActivities.length);
  assert.equal(result.counts.pipeline, sourcePipeline);

  const copies = all<any>(`SELECT * FROM activities WHERE company_id = ?`, target);
  assert.equal(copies.length, sourceActivities.length);
  assert.ok(copies.every((copy) => copy.assignee_id === "p_hfm2_raheel"), "every copy belongs to the target Raheel");
  assert.ok(copies.every((copy) => copy.copy_batch_id === result.batch.id), "every copy carries the batch id");
  assert.ok(copies.every((copy) => !!copy.copied_from_id), "the source row is recorded");
  assert.ok(copies.every((copy) => copy.source_dataset === `injected:${source}`));
  assert.equal(new Set(copies.map((copy) => copy.copied_from_id)).size, sourceActivities.length);

  const pipelineCopies = all<any>(`SELECT * FROM recording_pipeline WHERE company_id = ?`, target);
  assert.equal(pipelineCopies.length, sourcePipeline);
  assert.ok(pipelineCopies.every((copy) => copy.copy_batch_id === result.batch.id));

  // Source rows are byte-for-byte unchanged (ids, assignees, company, batch).
  assert.deepEqual(
    all<{ id: string; assignee_id: string | null }>(
      `SELECT id, assignee_id FROM activities WHERE company_id = ? ORDER BY id`,
      source
    ),
    sourceActivities
  );
  assert.equal(
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?`, source)!.n,
    sourcePipeline
  );
});

test("the target now sees only the copies; the source sees none of them", () => {
  const targetViewer = viewerFor(HFM2().id, "p_hfm2_raheel");
  const hfmViewer = viewerFor(HFM().id, loadOrg(HFM().id).people.find((p) => p.name === "Raheel Atta")!.id);
  const targetActivities = listActivities(targetViewer, { includeInactive: true });
  assert.ok(targetActivities.length >= 52);
  assert.ok(targetActivities.every((activity) => activity.copy_batch_id), "all target work is tagged as copied");
  assert.ok(targetActivities.every((activity) => activity.assignee_id === "p_hfm2_raheel"));
  assert.equal(targetActivities.filter((activity) => activity.project_name === "Store Stock Shipment").length, 1);
  assert.equal(listPipeline(targetViewer).length, 15);
  const hfmIds = new Set(listActivities(hfmViewer, { includeInactive: true }).map((activity) => activity.id));
  assert.ok(targetActivities.every((activity) => !hfmIds.has(activity.id)), "copy ids never collide with HFM");
});

test("re-running the copy is idempotent while the batch is active", () => {
  const source = HFM().id;
  const target = HFM2().id;
  const before = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, target)!.n;
  const again = injectTenantData({ sourceCompanyId: source, targetCompanyId: target, actorName: "test" });
  assert.equal(again.reused, true);
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, target)!.n, before);
  assert.equal(listInjectionBatches(target).filter((batch) => batch.status === "active").length, 1);
});

test("deleting the copy batch preserves every source record and allows a fresh copy", () => {
  const source = HFM().id;
  const target = HFM2().id;
  const sourceCount = get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, source)!.n;
  const sourcePipeline = get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?`, source)!.n;
  const batch = listInjectionBatches(target).find((row) => row.status === "active")!;
  const deleted = deleteTenantInjection({ batchId: batch.id, targetCompanyId: target, actorName: "test" });
  assert.equal(deleted.deleted.activities, sourceCount);
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, target)!.n, 0);
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?`, target)!.n, 0);
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, source)!.n, sourceCount);
  assert.equal(
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?`, source)!.n,
    sourcePipeline
  );
  assert.equal(listInjectionBatches(target)[0].status, "deleted");

  // A new batch may be created after deletion, proving the partial unique index
  // only allows one *active* batch per pair.
  const fresh = injectTenantData({ sourceCompanyId: source, targetCompanyId: target, actorName: "test" });
  assert.equal(fresh.reused, false);
  assert.notEqual(fresh.batch.id, batch.id);
  assert.equal(get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, target)!.n, sourceCount);
});

test("a forged target batch cannot delete rows outside its tenant", () => {
  const target = HFM2().id;
  const batch = listInjectionBatches(target).find((row) => row.status === "active")!;
  assert.throws(() => deleteTenantInjection({ batchId: batch.id, targetCompanyId: HFM().id, actorName: "test" }));
  assert.ok(get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE company_id = ?`, target)!.n > 0);
});

test("tenant provisioning constants are stable and documented", () => {
  assert.equal(HARRISFARM_TENANT.code, "HFM2");
  assert.equal(HARRISFARM_TENANT.companyId, "co_hfm2_harrisfarm");
  assert.deepEqual(
    HARRISFARM_TENANT.departments.map((department) => department.name),
    ["QA", "Release Management", "Test Automation", "Data Services"]
  );
});
