"use server";

import { revalidatePath } from "next/cache";
import { canAdmin, getViewer } from "@/lib/access";
import { recordAudit } from "@/lib/audit";
import {
  deleteTenantInjection,
  injectTenantData,
  defaultSourceCompanyId,
  defaultTargetCompanyId,
  listInjectionBatches,
} from "@/lib/tenant-injection";
import { ensureHarrisfarmMarketsTenant } from "@/lib/tenants";

export type TenantActionResult = { ok?: boolean; error?: string; message?: string };

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function refresh() {
  revalidatePath("/setup");
  revalidatePath("/", "layout");
  revalidatePath("/");
  revalidatePath("/calendar");
  revalidatePath("/pipeline");
  revalidatePath("/releases");
  revalidatePath("/reporting");
}

/** Create/reconcile the separate Harrisfarm Markets tenant. Admin-only, audited. */
export async function provisionTenantAction(
  _prev: TenantActionResult,
  _formData?: FormData
): Promise<TenantActionResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an application administrator can provision a tenant." };
  try {
    const result = ensureHarrisfarmMarketsTenant({ id: viewer.person.id, name: viewer.person.name });
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "tenant.provision",
      entity: "company",
      entityId: result.companyId,
      after: {
        company: "Harrisfarm Markets",
        entity: result.entityId,
        departments: result.departmentIds,
        people: result.people.map((person) => ({
          name: person.name,
          title: person.title,
          linkedPersonId: person.linkedPersonId,
        })),
      },
    });
    refresh();
    return {
      ok: true,
      message: `Tenant ready: ${result.people.length} QA people, ${result.departmentIds.length} departments. Existing HFM identities were linked, not duplicated.`,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Copy the source tenant's activities, pipeline, releases and related data into
 * the Harrisfarm Markets tenant. Repeating while a batch is active is a no-op.
 */
export async function injectTenantDataAction(
  _prev: TenantActionResult,
  formData: FormData
): Promise<TenantActionResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an application administrator can copy tenant data." };
  if (field(formData, "confirmation").toUpperCase() !== "COPY") {
    return { error: 'Type COPY to confirm. The originals are never modified and the copies can be deleted later.' };
  }
  try {
    const target = field(formData, "targetCompanyId") || defaultTargetCompanyId() || undefined;
    const source = field(formData, "sourceCompanyId") || defaultSourceCompanyId() || undefined;
    if (!source || !target) return { error: "Source or target tenant could not be resolved." };
    if (source === target) return { error: "Choose two different tenants." };
    const result = injectTenantData({
      sourceCompanyId: source,
      targetCompanyId: target,
      actorId: viewer.person.id,
      actorName: viewer.person.name,
    });
    refresh();
    return {
      ok: true,
      message: result.reused
        ? `An active copy batch already exists (${result.batch.id.slice(-8)}); nothing was duplicated.`
        : `Copied ${result.counts.activities} activities, ${result.counts.pipeline} pipeline items and ${result.counts.releaseFeed} releases. Every copy is assigned to Raheel Atta and tagged with batch ${result.batch.id.slice(-8)}.`,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Delete one tagged copy batch. The source tenant and unrelated rows are untouched. */
export async function deleteTenantInjectionAction(
  _prev: TenantActionResult,
  formData: FormData
): Promise<TenantActionResult> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return { error: "Only an application administrator can delete copied data." };
  const batchId = field(formData, "batchId");
  if (!batchId) return { error: "Choose a copy batch to delete." };
  if (field(formData, "confirmation").toUpperCase() !== "DELETE") {
    return { error: 'Type DELETE to confirm. Only tagged copies from this batch will be removed.' };
  }
  const target = field(formData, "targetCompanyId") || defaultTargetCompanyId() || null;
  const batch = listInjectionBatches(target).find((row) => row.id === batchId);
  if (!batch) return { error: "That batch does not belong to this tenant." };
  try {
    const result = deleteTenantInjection({
      batchId,
      targetCompanyId: target,
      actorId: viewer.person.id,
      actorName: viewer.person.name,
    });
    refresh();
    return {
      ok: true,
      message: `Deleted copy batch ${result.batch.id.slice(-8)} (${result.deleted.activities} activities, ${result.deleted.pipeline} pipeline items, ${result.deleted.releaseFeed} releases). Source records were preserved.`,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
