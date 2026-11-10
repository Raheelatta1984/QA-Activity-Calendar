/**
 * Provision (or reconcile) the separate Harrisfarm Markets tenant.
 *
 *   npm run db:provision
 *
 * Safe to repeat. Creates the tenant, its entity, its departments and the two
 * QA people copies; links them to existing HFM identities when present. It does
 * not copy activities, releases or pipeline items — use the in-app tenant data
 * panel (or ``scripts/inject-tenant-data.ts``) for that, which is also reversible.
 */
import { initDb } from "../lib/db";
import { ensureHarrisfarmMarketsTenant } from "../lib/tenants";

initDb();
const result = ensureHarrisfarmMarketsTenant({ name: "operator" });
console.log(
  `Harrisfarm Markets tenant: ${result.companyId} · entity ${result.entityId} · ` +
    `${result.departmentIds.length} departments · ${result.people.length} QA people`
);
console.log(
  `Created company=${result.createdCompany} entity=${result.createdEntity} ` +
    `departments=${result.createdDepartments} people=${result.createdPeople}`
);
for (const person of result.people) {
  console.log(` - ${person.name} (${person.title}) linked=${person.linkedPersonId ?? "not linked yet"}`);
}
