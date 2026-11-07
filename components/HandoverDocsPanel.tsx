import { Icon } from "@/components/icons";
import { STATUS_LABELS } from "@/lib/enhancement-status";
import type { HandoverDoc } from "@/lib/enhancement-docs";
import { syncEnhancementDocsAction } from "@/app/actions/enhancements";

export type DocRow = HandoverDoc & { linkedRef?: string | null; linkedStatus?: string | null };

function badgeFor(doc: DocRow): string {
  if (doc.archived) return "badge-slate";
  if (doc.status === "Built") return "badge-green";
  if (doc.status === "Building") return "badge-blue";
  return "badge-amber";
}

/**
 * The repository side of the enhancement vault: the handover documents that
 * exist in `lib/future-enhancements/` and whether the in-app request has
 * followed them to Building → Built → Archived.
 *
 * This is a server component; the only interaction is a form posting the
 * reconciliation action, which needs no client JavaScript.
 */
export function HandoverDocsPanel({
  active,
  archived,
  canEdit,
}: {
  active: DocRow[];
  archived: DocRow[];
  canEdit: boolean;
}) {
  const rows = [...active, ...archived];
  if (!rows.length) {
    return (
      <div className="empty">
        No handover documents are checked out in this build. A serverless deployment does not bundle
        <code className="mono"> lib/future-enhancements/</code>, so the vault above is the record — a deployment that
        includes the documents reconciles the statuses automatically.
      </div>
    );
  }

  const drift = rows.filter(
    (doc) => doc.linkedRef && (doc.archived ? doc.linkedStatus !== "Archived" : doc.linkedStatus === "Archived")
  );

  return (
    <div className="card-pad stack">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="badge badge-blue">{active.length} active</span>
        <span className="badge badge-slate">{archived.length} archived</span>
        {drift.length ? (
          <span className="badge badge-amber" title="Sync to align the in-app status with the documents">
            <Icon name="alert" size={11} /> {drift.length} status issue{drift.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="badge badge-green">
            <Icon name="check" size={11} /> statuses match the documents
          </span>
        )}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {rows.map((doc) => (
          <article className="card" key={doc.relativePath} style={{ padding: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
                {doc.ref ?? doc.name}
              </span>
              <strong style={{ fontSize: "0.9rem" }}>{doc.title ?? doc.name}</strong>
              <span className={`badge ${badgeFor(doc)}`}>{STATUS_LABELS[doc.status] ?? doc.status}</span>
              {doc.archived ? <span className="badge badge-slate">archived/</span> : null}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <span className="badge badge-slate mono" style={{ fontSize: "0.66rem" }}>
                {doc.relativePath}
              </span>
              {doc.linkedRef ? (
                <span className={`badge ${doc.archived && doc.linkedStatus === "Archived" ? "badge-green" : "badge-purple"}`}>
                  <Icon name="branch" size={11} /> in-app: {STATUS_LABELS[doc.linkedStatus ?? ""] ?? doc.linkedStatus ?? "—"}
                </span>
              ) : (
                <span className="badge badge-amber">no matching in-app request on this instance</span>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="banner info">
        <Icon name="branch" size={15} />
        <span>
          Lifecycle: <strong>Building</strong> publishes the handover, <strong>Built</strong> means the PR merged, and{" "}
          <strong>Archived</strong> is written once the file moves into{" "}
          <code className="mono">lib/future-enhancements/archived/</code>. The completion workflow moves the file and the
          next deployment syncs the status here, so the Markdown record and the request never disagree.
        </span>
      </div>

      {canEdit ? (
        <form action={syncEnhancementDocsAction}>
          <button className="btn btn-sm" type="submit" title="Reconcile statuses with the handover documents in this build">
            <Icon name="refresh" size={13} /> Sync statuses with the documents
          </button>
        </form>
      ) : null}
    </div>
  );
}
