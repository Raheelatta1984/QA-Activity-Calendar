import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated database for the organisation/login-scope suite.
const dbPath = path.join(os.tmpdir(), `qa-calendar-org-${process.pid}.db`);
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
const { all, get } = await import("../lib/db");
const { runHfmImport } = await import("../lib/hfm-import");
const { listCompanies, listEntities, listLoginAccounts, setDefaultCompany } = await import("../lib/org");

before(() => {
  bootstrapDatabase();
  const report = runHfmImport({ apply: true, requestedBy: "Raheel Atta" });
  if (report.errors.length) throw new Error(`HFM import failed in test setup: ${report.errors.join("; ")}`);
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

test("companies list shows three tenants with the HFM company as default", () => {
  const companies = listCompanies();
  assert.equal(companies.length, 3, "HFM, the demo tenant and the separate HFM2 tenant");
  const hfm = companies.find((company) => company.code === "HFM")!;
  const demo = companies.find((company) => company.name === "HFM")!;
  const hfm2 = companies.find((company) => company.code === "HFM2")!;
  assert.ok(hfm && demo && hfm2);
  assert.equal(hfm.is_default, 1);
  assert.equal(demo.is_default, 0);
  assert.equal(hfm2.is_default, 0);
  assert.equal(companies[0].id, hfm.id, "default company sorts first");
  // roll-up counts are real, not placeholders
  assert.equal(hfm.entity_count, 1);
  assert.ok(hfm.department_count >= 1);
  assert.ok(hfm.person_count >= 2);
  assert.ok(hfm.activity_count >= 52);
  assert.ok(demo.department_count >= 5);
  assert.ok(demo.person_count >= 10);
  // The separate tenant has its own entity and two department-bound people but
  // no activities until data is deliberately copied into it.
  assert.equal(hfm2.entity_count, 1);
  assert.equal(hfm2.department_count, 4);
  assert.equal(hfm2.person_count, 2);
  assert.equal(hfm2.activity_count, 0);
});

test("entities are listed per company; demo tenant has none", () => {
  const hfm = listCompanies().find((c) => c.name === "HarrisFarm Markets")!;
  const demo = listCompanies().find((c) => c.name === "HFM")!;
  const hfmEntities = listEntities(hfm.id);
  assert.equal(hfmEntities.length, 1);
  assert.equal(hfmEntities[0].name, "Harrisfarm");
  assert.ok(hfmEntities[0].department_count >= 1);
  assert.ok(hfmEntities[0].person_count >= 2);
  assert.equal(listEntities(demo.id).length, 0);
});

test("default login scope opens on the HFM company and lists only its people", () => {
  const scope = listLoginAccounts();
  assert.equal(scope.selectedCompanyId, scope.companies.find((c) => c.is_default === 1)!.id);
  assert.equal(scope.selectedEntityId, null);
  const names = scope.accounts.map((a) => a.name);
  assert.ok(names.includes("Damien Milthorpe"));
  assert.ok(names.includes("Raheel Atta"));
  assert.ok(!names.includes("Amara Okafor"), "demo identities do not leak into the HFM scope");
  // Imported principals have no credentials — flagged, not filled.
  for (const account of scope.accounts) {
    assert.equal(account.has_login, 0, `${account.name} is listed without inventing credentials`);
    assert.equal(account.is_demo, 0);
  }
});

test("entity-scoped login lists exactly the entity roster", () => {
  const hfm = listCompanies().find((c) => c.is_default === 1)!;
  const [entity] = listEntities(hfm.id);
  const scope = listLoginAccounts(hfm.id, entity.id);
  assert.equal(scope.selectedEntityId, entity.id);
  assert.deepEqual(
    scope.accounts.map((a) => a.name).sort(),
    ["Damien Milthorpe", "Raheel Atta"]
  );
});

test("demo tenant scope lists demo identities plus the department-less exec", () => {
  const demo = listCompanies().find((c) => c.name === "HFM")!;
  const scope = listLoginAccounts(demo.id);
  assert.equal(scope.selectedCompanyId, demo.id);
  assert.equal(scope.entities.length, 0);
  const names = scope.accounts.map((a) => a.name);
  assert.ok(names.includes("Amara Okafor"));
  assert.ok(names.includes("Priya Raman"), "department-less people still appear in the default company scope");
  assert.ok(!names.includes("Raheel Atta"), "HFM people stay in their own tenant");
  assert.ok(scope.accounts.filter((a) => a.is_demo === 1).length >= 10);
  assert.ok(scope.accounts.every((a) => (a.is_demo === 1 ? a.has_login === 1 : true)), "demo identities have the shared login");
});

test("setDefaultCompany flips the flag atomically and is reversible", () => {
  const [hfm, demo] = [
    listCompanies().find((c) => c.is_default === 1)!,
    listCompanies().find((c) => c.is_default === 0)!,
  ];
  setDefaultCompany(demo.id);
  let defaults = all<{ id: string }>("SELECT id FROM companies WHERE is_default = 1");
  assert.deepEqual(defaults.map((d) => d.id), [demo.id]);
  assert.equal(get<{ value: string }>("SELECT value FROM settings WHERE key = 'default_company_id'")?.value, demo.id);
  // Login scope now opens on the demo tenant.
  assert.equal(listLoginAccounts().selectedCompanyId, demo.id);
  setDefaultCompany(hfm.id);
  defaults = all<{ id: string }>("SELECT id FROM companies WHERE is_default = 1");
  assert.deepEqual(defaults.map((d) => d.id), [hfm.id]);
  assert.equal(listLoginAccounts().selectedCompanyId, hfm.id);
  // Unknown company id is rejected, flag unchanged.
  assert.throws(() => setDefaultCompany("co_nope"), /no longer exists/);
  assert.equal(all<{ id: string }>("SELECT id FROM companies WHERE is_default = 1")[0].id, hfm.id);
});

test("unknown company/entity params fall back safely", () => {
  const fallback = listLoginAccounts("co_nope", "ent_nope");
  assert.equal(fallback.selectedCompanyId, listCompanies().find((c) => c.is_default === 1)!.id);
  assert.equal(fallback.selectedEntityId, null);
  const hfm = listCompanies().find((c) => c.is_default === 1)!;
  const mismatched = listLoginAccounts(hfm.id, "ent_nope");
  assert.equal(mismatched.selectedEntityId, null, "entity from another tenant cannot be forced");
});
