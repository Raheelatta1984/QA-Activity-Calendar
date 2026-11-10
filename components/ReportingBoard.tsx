"use client";

import { useActionState, useEffect, useState } from "react";
import { Icon } from "./icons";
import { saveBugAction, deleteBugAction, type BugResult } from "@/app/actions/bugs";

export type ReportingBug = {
  id: string;
  bug_key: string;
  title: string;
  severity: string;
  status: string;
  derived_status: "Open" | "Fixed" | "Closed";
  reported_date: string | null;
  reporter_name: string | null;
  activity_id: string | null;
  activity_name: string | null;
  notes: string | null;
  is_demo: number;
  links: { service_id: string; service_name: string; status: string }[];
};

const SEVERITY_BADGE: Record<string, string> = {
  Critical: "badge-red",
  High: "badge-amber",
  Medium: "badge-blue",
  Low: "badge-slate",
};

export function ReportingBoard({
  bugs,
  services,
  activities,
  canEdit,
  path,
}: {
  bugs: ReportingBug[];
  services: { id: string; name: string; application_name: string }[];
  activities: { id: string; activity: string; project_name?: string | null }[];
  canEdit: boolean;
  path: string;
}) {
  const [editing, setEditing] = useState<ReportingBug | "new" | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "Open" | "Fixed" | "Closed">("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = bugs.filter((bug) => {
    if (statusFilter !== "all" && bug.derived_status !== statusFilter) return false;
    if (severityFilter !== "all" && bug.severity !== severityFilter) return false;
    if (search) {
      const term = search.toLowerCase();
      if (!`${bug.bug_key} ${bug.title} ${bug.activity_name ?? ""} ${bug.links.map((l) => l.service_name).join(" ")}`
        .toLowerCase()
        .includes(term))
        return false;
    }
    return true;
  });

  return (
    <div className="stack">
      <div className="row-between">
        <div className="filters">
          <div className="seg">
            {(["all", "Open", "Fixed", "Closed"] as const).map((s) => (
              <button key={s} className={statusFilter === s ? "active" : ""} onClick={() => setStatusFilter(s)}>
                {s === "all" ? "All" : s}
              </button>
            ))}
          </div>
          <select className="select select-sm" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
            <option value="all">All severities</option>
            {["Critical", "High", "Medium", "Low"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <input
            className="input input-sm"
            placeholder="Search ID, title, service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 220 }}
          />
        </div>
        {canEdit ? (
          <button className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} /> Report bug
          </button>
        ) : null}
      </div>

      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Severity</th>
              <th>Service links</th>
              <th>Derived</th>
              <th>Activity</th>
              <th>Reported</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((bug) => (
              <tr key={bug.id}>
                <td className="mono nowrap">{bug.bug_key}</td>
                <td style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>{bug.title}</div>
                  {bug.notes ? <div className="card-sub">{bug.notes}</div> : null}
                </td>
                <td>
                  <span className={`badge ${SEVERITY_BADGE[bug.severity] ?? "badge-slate"}`}>{bug.severity}</span>
                </td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {bug.links.length ? (
                      bug.links.map((link) => (
                        <span
                          key={link.service_id}
                          className={`badge ${
                            link.status === "Closed" ? "badge-green" : link.status === "Fixed" ? "badge-blue" : "badge-red"
                          }`}
                          title={`${link.service_name}: ${link.status}`}
                        >
                          {link.service_name} · {link.status}
                        </span>
                      ))
                    ) : (
                      <span className="muted" style={{ fontSize: "0.75rem" }}>No service linked</span>
                    )}
                  </div>
                </td>
                <td>
                  <span
                    className={`badge ${
                      bug.derived_status === "Closed"
                        ? "badge-green"
                        : bug.derived_status === "Fixed"
                          ? "badge-blue"
                          : "badge-red"
                    }`}
                  >
                    {bug.derived_status}
                  </span>
                </td>
                <td className="muted" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {bug.activity_name ?? "—"}
                </td>
                <td className="mono nowrap">{bug.reported_date ?? "—"}</td>
                <td className="right nowrap">
                  {canEdit ? (
                    <>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditing(bug)} title="Edit bug">
                        <Icon name="edit" size={12} />
                      </button>
                      <form action={deleteBugAction} style={{ display: "inline" }}>
                        <input type="hidden" name="id" value={bug.id} />
                        <button className="btn btn-sm btn-ghost" type="submit" title="Delete bug">
                          <Icon name="trash" size={12} />
                        </button>
                      </form>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty">No defects match this filter.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <BugForm
          bug={editing === "new" ? null : editing}
          services={services}
          activities={activities}
          path={path}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function BugForm({
  bug,
  services,
  activities,
  path,
  onClose,
}: {
  bug: ReportingBug | null;
  services: { id: string; name: string; application_name: string }[];
  activities: { id: string; activity: string; project_name?: string | null }[];
  path: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<BugResult, FormData>(saveBugAction, {});
  const [links, setLinks] = useState<{ service_id: string; status: string }[]>(
    bug ? bug.links.map((l) => ({ service_id: l.service_id, status: l.status })) : []
  );
  const [selectedService, setSelectedService] = useState("");

  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, onClose]);

  function addLink() {
    if (!selectedService) return;
    if (links.some((l) => l.service_id === selectedService)) return;
    setLinks([...links, { service_id: selectedService, status: "Open" }]);
    setSelectedService("");
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{bug ? `Edit ${bug.bug_key}` : "Report a defect"}</h2>
            <div className="card-sub">Overall status is derived from service links — one open link keeps it open.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <form action={formAction}>
          <div className="modal-body">
            <input type="hidden" name="id" value={bug?.id ?? ""} />
            <input type="hidden" name="path" value={path} />
            <div className="form-grid">
              <div className="field">
                <label>Bug ID *</label>
                <input className="input" name="bug_key" defaultValue={bug?.bug_key ?? ""} placeholder="HFM-1052" required />
              </div>
              <div className="field">
                <label>Severity</label>
                <select className="select" name="severity" defaultValue={bug?.severity ?? "Medium"}>
                  {["Critical", "High", "Medium", "Low"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="field span-2">
                <label>Title *</label>
                <input className="input" name="title" defaultValue={bug?.title ?? ""} required />
              </div>
              <div className="field">
                <label>Base status</label>
                <select className="select" name="status" defaultValue={bug?.status ?? "Open"}>
                  {["Open", "Fixed", "Closed"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Reported date</label>
                <input className="input" type="date" name="reported_date" defaultValue={bug?.reported_date ?? ""} />
              </div>
              <div className="field span-2">
                <label>Linked activity</label>
                <select className="select" name="activity_id" defaultValue={bug?.activity_id ?? ""}>
                  <option value="">Not linked</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.project_name ? `${a.project_name} · ` : ""}{a.activity}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field span-2">
                <label>Notes</label>
                <textarea className="textarea" name="notes" defaultValue={bug?.notes ?? ""} />
              </div>
            </div>

            <div className="divider" />
            <div className="label" style={{ marginBottom: 6 }}>Backend services affected</div>
            <div className="row">
              <select className="select select-sm" value={selectedService} onChange={(e) => setSelectedService(e.target.value)} style={{ maxWidth: 260 }}>
                <option value="">Add a service…</option>
                {services
                  .filter((s) => !links.some((l) => l.service_id === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.application_name} · {s.name}
                    </option>
                  ))}
              </select>
              <button className="btn btn-sm" type="button" onClick={addLink}>
                <Icon name="plus" size={13} /> Add link
              </button>
            </div>

            <div className="stack-sm" style={{ marginTop: 10 }}>
              {links.map((link, index) => {
                const service = services.find((s) => s.id === link.service_id);
                return (
                  <div className="row" key={link.service_id}>
                    <span className="badge badge-purple">{service ? `${service.application_name} · ${service.name}` : link.service_id}</span>
                    <select
                      className="select select-sm"
                      name="service_status"
                      value={link.status}
                      onChange={(e) => {
                        const next = [...links];
                        next[index] = { ...next[index], status: e.target.value };
                        setLinks(next);
                      }}
                      style={{ maxWidth: 120 }}
                    >
                      {["Open", "Fixed", "Closed"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                    <input type="hidden" name="service_ids" value={link.service_id} />
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => setLinks(links.filter((l) => l.service_id !== link.service_id))}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                );
              })}
              {!links.length ? <span className="card-sub">No services linked yet.</span> : null}
            </div>

            {state.error ? (
              <div className="banner bad" style={{ marginTop: 10 }}>
                <Icon name="alert" size={15} /> {state.error}
              </div>
            ) : null}
          </div>
          <div className="modal-foot">
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : bug ? "Save defect" : "Report defect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
