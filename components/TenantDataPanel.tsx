"use client";

import { useActionState } from "react";
import { Icon } from "./icons";
import {
  deleteTenantInjectionAction,
  injectTenantDataAction,
  provisionTenantAction,
  type TenantActionResult,
} from "@/app/actions/tenants";

type PreviewTable = { label: string; count: number };
type Batch = {
  id: string;
  label: string | null;
  status: string;
  counts: Record<string, number>;
  created_at: string;
};

export function TenantDataPanel({
  canAdmin,
  source,
  target,
  tables,
  batches,
  targetPeople,
}: {
  canAdmin: boolean;
  source: { id: string; name: string } | null;
  target: { id: string; name: string } | null;
  tables: PreviewTable[];
  batches: Batch[];
  targetPeople: { id: string; name: string; title: string | null; linked_person_id: string | null }[];
}) {
  const [provisionState, provisionAction, provisioning] = useActionState<TenantActionResult, FormData>(
    provisionTenantAction,
    {}
  );
  const [injectState, injectAction, injecting] = useActionState<TenantActionResult, FormData>(
    injectTenantDataAction,
    {}
  );
  const [deleteState, deleteAction, deleting] = useActionState<TenantActionResult, FormData>(
    deleteTenantInjectionAction,
    {}
  );

  const active = batches.filter((batch) => batch.status === "active");

  return (
    <div className="card-pad stack">
      {!canAdmin ? (
        <div className="banner warn">
          <Icon name="lock" size={15} />
          <span>Only an application administrator can provision, copy or delete tenant data.</span>
        </div>
      ) : null}

      <div className="grid-2">
        <div className="card card-pad">
          <div className="label">Separate tenant</div>
          <div className="stat-line"><span className="muted">Source</span><span>{source?.name ?? "HFM not found"}</span></div>
          <div className="stat-line"><span className="muted">Target</span><span>{target?.name ?? "Harrisfarm Markets not provisioned"}</span></div>
          <div className="card-sub" style={{ marginTop: 6 }}>
            The target is a different company row (code HFM2). It is not a rename or a duplicate of the HFM record.
          </div>
          {canAdmin ? (
            <form action={provisionAction} style={{ marginTop: 8 }}>
              <button className="btn btn-sm" type="submit" disabled={provisioning}>
                {provisioning ? "Provisioning…" : "Provision / reconcile tenant"}
              </button>
            </form>
          ) : null}
          {provisionState.message ? <div className="banner good" style={{ marginTop: 8 }}>{provisionState.message}</div> : null}
          {provisionState.error ? <div className="banner bad" style={{ marginTop: 8 }}>{provisionState.error}</div> : null}

          <div className="label" style={{ marginTop: 12 }}>QA people in the target tenant</div>
          {targetPeople.length ? targetPeople.map((person) => (
            <div className="stat-line" key={person.id}>
              <span>{person.name} <span className="muted">· {person.title ?? "—"}</span></span>
              <span className="badge badge-slate">{person.linked_person_id ? "linked identity" : "no login identity"}</span>
            </div>
          )) : <div className="empty">Provision the tenant to add Damien Milthorpe (QA Lead) and Raheel Atta (QA).</div>}
        </div>

        <div className="card card-pad">
          <div className="label">Copy HFM data into the new tenant</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Dataset</th><th className="num">Source rows</th></tr></thead>
              <tbody>
                {tables.map((table) => (
                  <tr key={table.label}><td>{table.label}</td><td className="num">{table.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 6 }}>
            Copies are assigned to Raheel Atta wherever an assignment exists and are tagged with a reversible batch id.
            The HFM originals are never modified.
          </div>
          {canAdmin && source && target ? (
            <form action={injectAction} className="stack-sm" style={{ marginTop: 8 }}>
              <input type="hidden" name="sourceCompanyId" value={source.id} />
              <input type="hidden" name="targetCompanyId" value={target.id} />
              <div className="field">
                <label>Type COPY to confirm</label>
                <input className="input input-sm" name="confirmation" placeholder="COPY" required />
              </div>
              <button className="btn btn-sm btn-primary" type="submit" disabled={injecting}>
                {injecting ? "Copying…" : active.length ? "Re-run copy (idempotent)" : "Copy into Harrisfarm Markets"}
              </button>
            </form>
          ) : null}
          {injectState.message ? <div className="banner good" style={{ marginTop: 8 }}>{injectState.message}</div> : null}
          {injectState.error ? <div className="banner bad" style={{ marginTop: 8 }}>{injectState.error}</div> : null}
        </div>
      </div>

      <div className="card card-pad stack-sm">
        <div className="label">Copy batches — permanent, tagged, deletable</div>
        {batches.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Batch</th><th>Created</th><th>Status</th><th className="num">Activities</th><th className="num">Pipeline</th><th className="num">Releases</th><th /></tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="mono" style={{ fontSize: "0.72rem" }}>{batch.id.slice(-10)}</td>
                    <td className="mono nowrap">{String(batch.created_at).slice(0, 16)}</td>
                    <td><span className={`badge ${batch.status === "active" ? "badge-green" : "badge-slate"}`}>{batch.status}</span></td>
                    <td className="num">{batch.counts.activities ?? 0}</td>
                    <td className="num">{batch.counts.pipeline ?? 0}</td>
                    <td className="num">{batch.counts.releaseFeed ?? 0}</td>
                    <td className="right">
                      {canAdmin && batch.status === "active" && target ? (
                        <form action={deleteAction} className="inline-form">
                          <input type="hidden" name="batchId" value={batch.id} />
                          <input type="hidden" name="targetCompanyId" value={target.id} />
                          <input className="input input-sm" name="confirmation" placeholder="Type DELETE" style={{ width: 104 }} required />
                          <button className="btn btn-sm btn-danger" type="submit" disabled={deleting}>Delete copies</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No copy batches yet.</div>}
        {deleteState.message ? <div className="banner good">{deleteState.message}</div> : null}
        {deleteState.error ? <div className="banner bad">{deleteState.error}</div> : null}
        <div className="card-sub">
          Deleting a batch removes only rows carrying that batch id in the target tenant. HFM records and unrelated
          rows are not referenced by the delete statements.
        </div>
      </div>
    </div>
  );
}
