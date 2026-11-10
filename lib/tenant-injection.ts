import { all, get, run, transaction } from "./db";
import { uid } from "./ids";
import { recordAudit } from "./audit";
import { ensureHarrisfarmMarketsTenant, HARRISFARM_TENANT } from "./tenants";

/**
 * Copy HFM's operational data into the separate Harrisfarm Markets tenant.
 *
 * Design rules
 *   * Only rows owned by the *source* company are read. Rows from the demo
 *     tenant, the target tenant or any other company are never touched.
 *   * Every copied row carries `copy_batch_id` (the reversible batch) and
 *     `copied_from_id` (the untouched source row). The source row's id, dates,
 *     assignee, status and project name are never modified.
 *   * Copies are assigned to the target tenant's Raheel Atta wherever an
 *     assignment exists (activity assignee/assignments, pipeline assignee,
 *     release owner/assignees, bug reporter, capacity entries).
 *   * Repeat-safe: while a batch is active, re-running returns that batch and
 *     writes nothing. After a batch is deleted, a new batch may be created.
 *   * Deleting a batch removes only rows carrying that batch id inside the
 *     target company (plus their cascade children). The originals stay.
 */

export const INJECTION_DATASET = (sourceCompanyId: string) => `injected:${sourceCompanyId}`;

export type InjectionCounts = {
  activities: number;
  activityAssignments: number;
  effortOverrides: number;
  progressSnapshots: number;
  pipeline: number;
  pipelineExclusions: number;
  releaseFeed: number;
  releaseAssignees: number;
  releaseGovernance: number;
  pquTrains: number;
  bugs: number;
  bugLinks: number;
  applications: number;
  services: number;
  deploymentPlans: number;
  capacityEntries: number;
};

const EMPTY_COUNTS: InjectionCounts = {
  activities: 0,
  activityAssignments: 0,
  effortOverrides: 0,
  progressSnapshots: 0,
  pipeline: 0,
  pipelineExclusions: 0,
  releaseFeed: 0,
  releaseAssignees: 0,
  releaseGovernance: 0,
  pquTrains: 0,
  bugs: 0,
  bugLinks: 0,
  applications: 0,
  services: 0,
  deploymentPlans: 0,
  capacityEntries: 0,
};

export type InjectionBatch = {
  id: string;
  source_company_id: string;
  target_company_id: string;
  label: string | null;
  status: string;
  counts: InjectionCounts;
  created_at: string;
  deleted_at: string | null;
};

export function defaultSourceCompanyId(): string | null {
  return (
    get<{ id: string }>("SELECT id FROM companies WHERE code = 'HFM' LIMIT 1")?.id ??
    get<{ id: string }>("SELECT id FROM companies WHERE is_default = 1 LIMIT 1")?.id ??
    null
  );
}

export function defaultTargetCompanyId(): string | null {
  return (
    get<{ id: string }>("SELECT id FROM companies WHERE code = ? LIMIT 1", HARRISFARM_TENANT.code)?.id ?? null
  );
}

function parseCounts(raw: string | null | undefined): InjectionCounts {
  if (!raw) return { ...EMPTY_COUNTS };
  try {
    return { ...EMPTY_COUNTS, ...(JSON.parse(raw) as Partial<InjectionCounts>) };
  } catch {
    return { ...EMPTY_COUNTS };
  }
}

function batchRow(row: any): InjectionBatch {
  return {
    id: row.id,
    source_company_id: row.source_company_id,
    target_company_id: row.target_company_id,
    label: row.label ?? null,
    status: row.status,
    counts: parseCounts(row.counts_json),
    created_at: row.created_at,
    deleted_at: row.deleted_at ?? null,
  };
}

export function listInjectionBatches(targetCompanyId?: string | null): InjectionBatch[] {
  return all<any>(
    `SELECT * FROM tenant_injections ${targetCompanyId ? "WHERE target_company_id = ?" : ""}
      ORDER BY created_at DESC`,
    ...(targetCompanyId ? [targetCompanyId] : [])
  ).map(batchRow);
}

export function activeInjection(
  sourceCompanyId: string,
  targetCompanyId: string
): InjectionBatch | null {
  const row = get<any>(
    `SELECT * FROM tenant_injections
      WHERE source_company_id = ? AND target_company_id = ? AND status = 'active' LIMIT 1`,
    sourceCompanyId,
    targetCompanyId
  );
  return row ? batchRow(row) : null;
}

type PreviewTable = { label: string; count: number };

export function previewTenantInjection(options?: {
  sourceCompanyId?: string | null;
  targetCompanyId?: string | null;
}) {
  const sourceCompanyId = options?.sourceCompanyId ?? defaultSourceCompanyId();
  const targetCompanyId = options?.targetCompanyId ?? defaultTargetCompanyId();
  if (!sourceCompanyId || !targetCompanyId) {
    return {
      source: null,
      target: null,
      tables: [] as PreviewTable[],
      activeBatch: null,
      targetPeople: [],
    };
  }
  const source = get<any>("SELECT * FROM companies WHERE id = ?", sourceCompanyId);
  const target = get<any>("SELECT * FROM companies WHERE id = ?", targetCompanyId);
  const count = (sql: string, ...params: unknown[]) =>
    Number(get<{ n: number }>(sql, ...params)?.n ?? 0);
  const tables: PreviewTable[] = [
    { label: "Activities", count: count("SELECT COUNT(*) AS n FROM activities WHERE company_id = ?", sourceCompanyId) },
    {
      label: "Recording pipeline items",
      count: count("SELECT COUNT(*) AS n FROM recording_pipeline WHERE company_id = ?", sourceCompanyId),
    },
    {
      label: "Pipeline exclusions",
      count: count("SELECT COUNT(*) AS n FROM pipeline_exclusions WHERE company_id = ?", sourceCompanyId),
    },
    { label: "Releases", count: count("SELECT COUNT(*) AS n FROM release_feed WHERE company_id = ?", sourceCompanyId) },
    {
      label: "Release governance decisions",
      count: count("SELECT COUNT(*) AS n FROM release_governance WHERE company_id = ?", sourceCompanyId),
    },
    { label: "PQU trains", count: count("SELECT COUNT(*) AS n FROM pqu_trains WHERE company_id = ?", sourceCompanyId) },
    { label: "Defects", count: count("SELECT COUNT(*) AS n FROM bugs WHERE company_id = ?", sourceCompanyId) },
    {
      label: "Capacity entries",
      count: count(
        `SELECT COUNT(*) AS n FROM resource_day_capacity r
           JOIN people p ON p.id = r.person_id
           JOIN departments d ON d.id = p.department_id
          WHERE d.company_id = ?`,
        sourceCompanyId
      ),
    },
  ];
  const targetPeople = all<{ id: string; name: string; title: string | null; linked_person_id: string | null }>(
    `SELECT p.id, p.name, p.title, p.linked_person_id
       FROM people p JOIN departments d ON d.id = p.department_id
      WHERE d.company_id = ? ORDER BY p.name`,
    targetCompanyId
  );
  return {
    source,
    target,
    tables,
    activeBatch: activeInjection(sourceCompanyId, targetCompanyId),
    targetPeople,
  };
}

const ACTIVITY_SKIP = new Set(["id", "company_id", "department_id", "assignee_id", "source_dataset", "external_source_id", "copy_batch_id", "copied_from_id", "created_at", "updated_at"]);
const PIPELINE_SKIP = new Set(["id", "company_id", "department_id", "assignee_id", "source_dataset", "external_source_id", "copy_batch_id", "copied_from_id", "created_at"]);

function insertCopy(
  table: string,
  source: Record<string, any>,
  overrides: Record<string, any>,
  skip: Set<string>
) {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || key in overrides) continue;
    columns.push(key);
    values.push(value ?? null);
  }
  for (const [key, value] of Object.entries(overrides)) {
    columns.push(key);
    values.push(value ?? null);
  }
  run(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...values
  );
}

function targetRaheel(targetCompanyId: string): { id: string; name: string } {
  const person = get<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM people p JOIN departments d ON d.id = p.department_id
      WHERE d.company_id = ? AND p.name = 'Raheel Atta' ORDER BY p.created_at LIMIT 1`,
    targetCompanyId
  );
  if (!person) {
    throw new Error("The target tenant has no Raheel Atta person; provision the tenant first.");
  }
  return person;
}

function targetQaDepartment(targetCompanyId: string): string {
  const department = get<{ id: string }>(
    `SELECT id FROM departments WHERE company_id = ? AND code = ? LIMIT 1`,
    targetCompanyId,
    "QA"
  );
  if (!department) throw new Error("The target tenant has no QA department.");
  return department.id;
}

/**
 * Inject a reversible copy of the source tenant's operational data.
 * Returns the active batch (existing or newly created) and per-table counts.
 */
export function injectTenantData(options?: {
  sourceCompanyId?: string | null;
  targetCompanyId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  label?: string | null;
}) {
  const sourceCompanyId = options?.sourceCompanyId ?? defaultSourceCompanyId();
  const targetCompanyId = options?.targetCompanyId ?? defaultTargetCompanyId();
  if (!sourceCompanyId || !targetCompanyId) {
    throw new Error("Both source and target companies are required.");
  }
  if (sourceCompanyId === targetCompanyId) {
    throw new Error("Source and target tenants must be different companies.");
  }
  const source = get<any>("SELECT * FROM companies WHERE id = ?", sourceCompanyId);
  const target = get<any>("SELECT * FROM companies WHERE id = ?", targetCompanyId);
  if (!source || !target) throw new Error("Source or target company no longer exists.");

  // Link the HFM identities and guarantee the two QA people exist.
  ensureHarrisfarmMarketsTenant({ id: options?.actorId ?? null, name: options?.actorName ?? null });
  const raheel = targetRaheel(targetCompanyId);
  const qaDepartmentId = targetQaDepartment(targetCompanyId);

  return transaction(() => {
    const existing = activeInjection(sourceCompanyId, targetCompanyId);
    if (existing) {
      return { batch: existing, reused: true, counts: existing.counts };
    }

    const batchId = uid("inj");
    const label = options?.label ?? `HFM → Harrisfarm Markets (${new Date().toISOString().slice(0, 10)})`;
    run(
      `INSERT INTO tenant_injections (id, source_company_id, target_company_id, label, status, created_by)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      batchId,
      sourceCompanyId,
      targetCompanyId,
      label,
      options?.actorId ?? null
    );

    const counts: InjectionCounts = { ...EMPTY_COUNTS };
    const dataset = INJECTION_DATASET(sourceCompanyId);
    const activityMap = new Map<string, string>();
    const pipelineMap = new Map<string, string>();
    const releaseMap = new Map<string, string>();
    const applicationMap = new Map<string, string>();
    const serviceMap = new Map<string, string>();
    const bugMap = new Map<string, string>();

    // ---- activities -------------------------------------------------------
    for (const activity of all<any>("SELECT * FROM activities WHERE company_id = ?", sourceCompanyId)) {
      const previous = get<{ id: string }>(
        `SELECT id FROM activities WHERE company_id = ? AND source_dataset = ? AND external_source_id = ?`,
        targetCompanyId,
        dataset,
        activity.id
      )?.id;
      if (previous) {
        activityMap.set(activity.id, previous);
        continue;
      }
      const id = uid("act");
      insertCopy(
        "activities",
        activity,
        {
          id,
          company_id: targetCompanyId,
          department_id: qaDepartmentId,
          assignee_id: raheel.id,
          source_dataset: dataset,
          external_source_id: activity.id,
          copy_batch_id: batchId,
          copied_from_id: activity.id,
        },
        ACTIVITY_SKIP
      );
      activityMap.set(activity.id, id);
      counts.activities += 1;
    }

    // activity assignments / overrides / snapshots
    for (const assignment of all<any>("SELECT * FROM activity_assignments")) {
      const newActivityId = activityMap.get(assignment.activity_id);
      if (!newActivityId) continue;
      run(
        `INSERT OR IGNORE INTO activity_assignments (id, activity_id, person_id, share) VALUES (?, ?, ?, ?)`,
        uid("aa"),
        newActivityId,
        raheel.id,
        assignment.share ?? 1
      );
      counts.activityAssignments += 1;
    }
    for (const override of all<any>("SELECT * FROM effort_overrides")) {
      const newActivityId = activityMap.get(override.activity_id);
      if (!newActivityId) continue;
      run(
        `INSERT INTO effort_overrides (id, activity_id, person_id, date, fte, hours, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        uid("eo"),
        newActivityId,
        raheel.id,
        override.date,
        override.fte ?? null,
        override.hours ?? null,
        override.reason ?? null
      );
      counts.effortOverrides += 1;
    }
    for (const snapshot of all<any>("SELECT * FROM progress_snapshots")) {
      const newActivityId = activityMap.get(snapshot.activity_id);
      if (!newActivityId) continue;
      run(
        `INSERT INTO progress_snapshots (id, activity_id, as_of, reported, fixed, closed, outstanding, progress_percent, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid("ps"),
        newActivityId,
        snapshot.as_of,
        snapshot.reported ?? 0,
        snapshot.fixed ?? 0,
        snapshot.closed ?? 0,
        snapshot.outstanding ?? 0,
        snapshot.progress_percent ?? null,
        snapshot.notes ?? null
      );
      counts.progressSnapshots += 1;
    }

    // ---- recording pipeline ----------------------------------------------
    for (const item of all<any>("SELECT * FROM recording_pipeline WHERE company_id = ?", sourceCompanyId)) {
      const previous = get<{ id: string }>(
        `SELECT id FROM recording_pipeline WHERE company_id = ? AND source_dataset = ? AND external_source_id = ?`,
        targetCompanyId,
        dataset,
        item.id
      )?.id;
      if (previous) {
        pipelineMap.set(item.id, previous);
        continue;
      }
      const id = uid("pipe");
      insertCopy(
        "recording_pipeline",
        item,
        {
          id,
          company_id: targetCompanyId,
          department_id: qaDepartmentId,
          assignee_id: raheel.id,
          source_dataset: dataset,
          external_source_id: item.id,
          copy_batch_id: batchId,
          copied_from_id: item.id,
        },
        PIPELINE_SKIP
      );
      pipelineMap.set(item.id, id);
      counts.pipeline += 1;
    }

    for (const exclusion of all<any>("SELECT * FROM pipeline_exclusions WHERE company_id = ?", sourceCompanyId)) {
      const newPipelineId = exclusion.pipeline_id ? pipelineMap.get(exclusion.pipeline_id) : null;
      if (exclusion.pipeline_id && !newPipelineId) continue;
      run(
        `INSERT OR IGNORE INTO pipeline_exclusions
           (id, pipeline_id, date, reason, created_by, source_dataset, source_row, exclusion_warning, import_batch_id,
            company_id, copy_batch_id, copied_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid("pex"),
        newPipelineId,
        exclusion.date,
        exclusion.reason,
        raheel.id,
        exclusion.source_dataset ?? null,
        exclusion.source_row ?? null,
        exclusion.exclusion_warning ?? null,
        exclusion.import_batch_id ?? null,
        targetCompanyId,
        batchId,
        exclusion.id
      );
      counts.pipelineExclusions += 1;
    }

    // ---- applications / services / deployment plans ----------------------
    for (const application of all<any>("SELECT * FROM applications WHERE company_id = ?", sourceCompanyId)) {
      const id = uid("app");
      insertCopy(
        "applications",
        application,
        { id, company_id: targetCompanyId, copy_batch_id: batchId, copied_from_id: application.id },
        new Set(["id", "company_id", "copy_batch_id", "copied_from_id"])
      );
      applicationMap.set(application.id, id);
      counts.applications += 1;
    }
    for (const service of all<any>("SELECT * FROM backend_services WHERE company_id = ?", sourceCompanyId)) {
      const id = uid("svc");
      insertCopy(
        "backend_services",
        service,
        {
          id,
          company_id: targetCompanyId,
          application_id: service.application_id ? applicationMap.get(service.application_id) ?? null : null,
          copy_batch_id: batchId,
          copied_from_id: service.id,
        },
        new Set(["id", "company_id", "application_id", "copy_batch_id", "copied_from_id"])
      );
      serviceMap.set(service.id, id);
      counts.services += 1;
    }
    for (const plan of all<any>("SELECT * FROM service_deployment_plans WHERE company_id = ?", sourceCompanyId)) {
      insertCopy(
        "service_deployment_plans",
        plan,
        {
          id: uid("sdp"),
          company_id: targetCompanyId,
          application_id: plan.application_id ? applicationMap.get(plan.application_id) ?? null : null,
          copy_batch_id: batchId,
          copied_from_id: plan.id,
        },
        new Set(["id", "company_id", "application_id", "copy_batch_id", "copied_from_id"])
      );
      counts.deploymentPlans += 1;
    }

    // ---- releases ---------------------------------------------------------
    for (const release of all<any>("SELECT * FROM release_feed WHERE company_id = ?", sourceCompanyId)) {
      const id = uid("rf");
      insertCopy(
        "release_feed",
        release,
        {
          id,
          company_id: targetCompanyId,
          department_id: qaDepartmentId,
          qa_owner_id: raheel.id,
          copy_batch_id: batchId,
          copied_from_id: release.id,
        },
        new Set(["id", "company_id", "department_id", "qa_owner_id", "copy_batch_id", "copied_from_id"])
      );
      releaseMap.set(release.id, id);
      counts.releaseFeed += 1;

      const sourceAssignees = all<any>("SELECT * FROM release_assignees WHERE release_id = ?", release.id);
      const fte = sourceAssignees.reduce((sum, row) => sum + Number(row.fte ?? 0), 0) || 0.5;
      run(
        `INSERT OR IGNORE INTO release_assignees (id, release_id, person_id, role, fte, created_at, updated_at)
         VALUES (?, ?, ?, 'QA', ?, datetime('now'), datetime('now'))`,
        uid("rla"),
        id,
        raheel.id,
        Math.round(Math.min(5, Math.max(0.1, fte)) * 100) / 100
      );
      counts.releaseAssignees += 1;
    }

    for (const decision of all<any>("SELECT * FROM release_governance WHERE company_id = ?", sourceCompanyId)) {
      insertCopy(
        "release_governance",
        decision,
        {
          id: uid("rg"),
          company_id: targetCompanyId,
          department_id: qaDepartmentId,
          release_id: releaseMap.get(decision.release_id) ?? decision.release_id,
          decided_by: raheel.id,
          copy_batch_id: batchId,
          copied_from_id: decision.id,
        },
        new Set(["id", "company_id", "department_id", "release_id", "decided_by", "copy_batch_id", "copied_from_id"])
      );
      counts.releaseGovernance += 1;
    }
    for (const train of all<any>("SELECT * FROM pqu_trains WHERE company_id = ?", sourceCompanyId)) {
      insertCopy(
        "pqu_trains",
        train,
        { id: uid("pqu"), company_id: targetCompanyId, copy_batch_id: batchId, copied_from_id: train.id },
        new Set(["id", "company_id", "copy_batch_id", "copied_from_id"])
      );
      counts.pquTrains += 1;
    }

    // ---- defects ----------------------------------------------------------
    for (const bug of all<any>("SELECT * FROM bugs WHERE company_id = ?", sourceCompanyId)) {
      const id = uid("bug");
      insertCopy(
        "bugs",
        bug,
        {
          id,
          bug_key: `INJ-${bug.bug_key}`,
          company_id: targetCompanyId,
          department_id: qaDepartmentId,
          reported_by: raheel.id,
          activity_id: bug.activity_id ? activityMap.get(bug.activity_id) ?? null : null,
          copy_batch_id: batchId,
          copied_from_id: bug.id,
        },
        new Set(["id", "company_id", "department_id", "reported_by", "activity_id", "bug_key", "copy_batch_id", "copied_from_id"])
      );
      bugMap.set(bug.id, id);
      counts.bugs += 1;
    }
    for (const link of all<any>("SELECT * FROM bug_service_links")) {
      const newBugId = bugMap.get(link.bug_id);
      if (!newBugId) continue;
      const newServiceId = serviceMap.get(link.service_id);
      if (!newServiceId) continue;
      run(
        `INSERT INTO bug_service_links (id, bug_id, service_id, status, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        uid("bsl"),
        newBugId,
        newServiceId,
        link.status ?? "Open"
      );
      counts.bugLinks += 1;
    }

    // ---- capacity ---------------------------------------------------------
    const sourcePeopleIds = all<{ id: string }>(
      `SELECT p.id FROM people p JOIN departments d ON d.id = p.department_id WHERE d.company_id = ?`,
      sourceCompanyId
    ).map((row) => row.id);
    if (sourcePeopleIds.length) {
      const placeholders = sourcePeopleIds.map(() => "?").join(",");
      for (const entry of all<any>(
        `SELECT * FROM resource_day_capacity WHERE person_id IN (${placeholders})`,
        ...sourcePeopleIds
      )) {
        const already = get<{ id: string }>(
          "SELECT id FROM resource_day_capacity WHERE person_id = ? AND date = ?",
          raheel.id,
          entry.date
        );
        if (already) continue;
        run(
          `INSERT INTO resource_day_capacity
             (id, person_id, date, not_available_hours, devops_hours, recording_hours, qa_testing_hours, total_hours, note, source, copy_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid("rdc"),
          raheel.id,
          entry.date,
          entry.not_available_hours ?? 0,
          entry.devops_hours ?? 0,
          entry.recording_hours ?? 0,
          entry.qa_testing_hours ?? 0,
          entry.total_hours ?? 7.6,
          entry.note ?? null,
          "tenant-injection",
          batchId
        );
        counts.capacityEntries += 1;
      }
    }

    run(`UPDATE tenant_injections SET counts_json = ? WHERE id = ?`, JSON.stringify(counts), batchId);
    recordAudit({
      actorId: options?.actorId ?? null,
      actorName: options?.actorName ?? null,
      action: "tenant.inject",
      entity: "tenant_injection",
      entityId: batchId,
      after: { sourceCompanyId, targetCompanyId, counts, assignedTo: raheel.name },
      meta: { reversible: true, dataset },
      companyId: targetCompanyId,
    });
    const batch = get<any>("SELECT * FROM tenant_injections WHERE id = ?", batchId);
    return { batch: batchRow(batch), reused: false, counts };
  });
}

export type DeletionResult = {
  batch: InjectionBatch;
  deleted: InjectionCounts;
};

/**
 * Delete exactly one injection batch from its target tenant. Confirmation is
 * enforced by the caller (the server action) and the batch must belong to the
 * selected tenant; originals in the source company are never referenced.
 */
export function deleteTenantInjection(options: {
  batchId: string;
  targetCompanyId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
}): DeletionResult {
  const targetCompanyId = options.targetCompanyId ?? defaultTargetCompanyId();
  if (!targetCompanyId) throw new Error("A target company is required.");
  return transaction(() => {
    const batch = get<any>(
      `SELECT * FROM tenant_injections WHERE id = ? AND target_company_id = ?`,
      options.batchId,
      targetCompanyId
    );
    if (!batch) throw new Error("Injection batch not found in this tenant.");
    if (batch.status !== "active") throw new Error("This batch has already been deleted.");
    const batchId = batch.id;
    const counts = parseCounts(batch.counts_json);

    const del = (table: string, sql: string, ...params: unknown[]) => {
      run(sql, ...params);
    };
    // Children first. Every statement is scoped by batch AND target company;
    // resource_day_capacity has no company column, so the batch id is the key.
    del("bug_service_links",
      `DELETE FROM bug_service_links WHERE bug_id IN (SELECT id FROM bugs WHERE copy_batch_id = ? AND company_id = ?)`,
      batchId, targetCompanyId);
    del("bugs", `DELETE FROM bugs WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("release_assignees",
      `DELETE FROM release_assignees WHERE release_id IN (SELECT id FROM release_feed WHERE copy_batch_id = ? AND company_id = ?)`,
      batchId, targetCompanyId);
    del("release_governance", `DELETE FROM release_governance WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("release_feed", `DELETE FROM release_feed WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("pqu_trains", `DELETE FROM pqu_trains WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("pipeline_exclusions", `DELETE FROM pipeline_exclusions WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("recording_pipeline", `DELETE FROM recording_pipeline WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("service_deployment_plans", `DELETE FROM service_deployment_plans WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("backend_services", `DELETE FROM backend_services WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("applications", `DELETE FROM applications WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("activities", `DELETE FROM activities WHERE copy_batch_id = ? AND company_id = ?`, batchId, targetCompanyId);
    del("resource_day_capacity", `DELETE FROM resource_day_capacity WHERE copy_batch_id = ?`, batchId);

    run(
      `UPDATE tenant_injections SET status = 'deleted', deleted_at = datetime('now'), deleted_by = ? WHERE id = ?`,
      options.actorId ?? null,
      batchId
    );
    recordAudit({
      actorId: options.actorId ?? null,
      actorName: options.actorName ?? null,
      action: "tenant.injection.delete",
      entity: "tenant_injection",
      entityId: batchId,
      before: { status: "active", counts },
      after: { status: "deleted" },
      meta: { targetCompanyId, originalsPreserved: true },
      companyId: targetCompanyId,
    });
    const updated = get<any>("SELECT * FROM tenant_injections WHERE id = ?", batchId);
    return { batch: batchRow(updated), deleted: counts };
  });
}
