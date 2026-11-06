"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import type { ClientDepartment, ClientPerson, ClientPipeline, DayMeta } from "./types";
import {
  savePipelineAction,
  deletePipelineAction,
  updateRecordingAction,
  type PipelineResult,
} from "@/app/actions/pipeline";

const STATUSES = ["Pending", "Recording", "Recorded", "On hold", "Blocked", "Complete", "Cancelled"];
const RECORDING_STATUSES = ["Not started", "Scripted", "In progress", "Complete", "Testing"];

export function PipelineBoard({
  items,
  people,
  departments,
  canEdit,
  path,
  availability,
}: {
  items: ClientPipeline[];
  people: ClientPerson[];
  departments: ClientDepartment[];
  canEdit: boolean;
  path: string;
  availability: DayMeta[];
}) {
  const [filter, setFilter] = useState<"all" | "actionable" | "blocked" | "test">("all");
  const [owner, setOwner] = useState("all");
  const [editing, setEditing] = useState<ClientPipeline | "new" | null>(null);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (filter === "blocked" && item.current_status !== "Blocked") return false;
      if (filter === "test" && !item.is_test) return false;
      if (filter === "actionable" && (item.is_test || item.current_status === "Complete")) return false;
      if (owner !== "all" && item.assignee_name !== owner) return false;
      return true;
    });
  }, [items, filter, owner]);

  return (
    <div className="stack">
      <div className="row-between">
        <div className="seg">
          {(["all", "actionable", "blocked", "test"] as const).map((mode) => (
            <button key={mode} className={filter === mode ? "active" : ""} onClick={() => setFilter(mode)}>
              {mode === "all" ? `All (${items.length})` : mode === "actionable" ? "Actionable" : mode === "blocked" ? "Blocked" : "TEST records"}
            </button>
          ))}
        </div>
        <div className="row">
          <select className="select select-sm" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
            <option value="all">All owners</option>
            {[...new Set(items.map((i) => i.assignee_name))].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {canEdit ? (
            <button className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" size={14} /> New recording
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid-2">
        {filtered.map((item) => (
          <article className="card" key={item.id} style={{ borderLeft: `3px solid ${item.colour}` }}>
            <div className="card-head" style={{ padding: "12px 14px" }}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong style={{ fontSize: "0.9rem" }}>{item.activity}</strong>
                  {item.is_test ? <span className="badge badge-amber">TEST</span> : null}
                </div>
                <div className="card-sub">
                  <span className="mono">{item.code}</span> · {item.assignee_name}
                </div>
              </div>
              <span
                className={`badge ${
                  item.current_status === "Blocked"
                    ? "badge-red"
                    : item.current_status === "Complete" || item.current_status === "Recorded"
                      ? "badge-green"
                      : item.current_status === "Recording"
                        ? "badge-blue"
                        : "badge-slate"
                }`}
              >
                {item.current_status}
              </span>
            </div>
            <div className="card-body" style={{ padding: 14 }}>
              <div className="row-between" style={{ fontSize: "0.78rem" }}>
                <span className="muted">Effective window</span>
                <span>
                  {item.effective_start ?? "—"} → {item.effective_end ?? "—"}
                </span>
              </div>
              <div className="row-between" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                <span className="muted">Eligible days</span>
                <span>
                  <strong>{item.eligible_days}</strong>
                  {item.blocked_days.length ? (
                    <span className="badge badge-amber" style={{ marginLeft: 6 }}>
                      {item.blocked_days.length} blocked
                    </span>
                  ) : null}
                </span>
              </div>
              <div style={{ marginTop: 8 }}>
                <div className="row-between" style={{ fontSize: "0.72rem", marginBottom: 3 }}>
                  <span className="muted">Automation</span>
                  <span>{item.automation_percent}%</span>
                </div>
                <div className={`progress ${item.automation_percent >= 80 ? "good" : item.automation_percent < 30 ? "warn" : ""}`}>
                  <span style={{ width: `${Math.max(2, item.automation_percent)}%` }} />
                </div>
              </div>

              {item.blocker ? (
                <div className="banner bad" style={{ marginTop: 10, fontSize: "0.75rem" }}>
                  <Icon name="alert" size={13} /> {item.blocker}
                </div>
              ) : null}

              {item.warnings.length ? (
                <ul className="insight-evidence" style={{ marginTop: 8 }}>
                  {item.warnings.slice(0, 2).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}

              <div className="row" style={{ marginTop: 10 }}>
                {canEdit ? (
                  <>
                    <button className="btn btn-sm" onClick={() => setEditing(item)}>
                      <Icon name="edit" size={12} /> Edit
                    </button>
                    <form action={updateRecordingAction} className="row" style={{ gap: 4 }}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="path" value={path} />
                      <input
                        className="input input-sm"
                        type="number"
                        min={0}
                        max={100}
                        name="automation_percent"
                        defaultValue={item.automation_percent}
                        style={{ width: 70 }}
                        aria-label="Automation percent"
                      />
                      <button className="btn btn-sm btn-ghost" type="submit">
                        Log %
                      </button>
                    </form>
                  </>
                ) : null}
              </div>
            </div>
          </article>
        ))}
        {!filtered.length ? <div className="empty">No recordings match this filter.</div> : null}
      </div>

      <div className="cal-legend">
        <span>Availability strip for the current month:</span>
        {availability.slice(0, 31).map((day) => (
          <span
            key={day.date}
            title={`${day.date}${day.holidayName ? ` · ${day.holidayName}` : ""}`}
            style={{
              display: "inline-block",
              width: 16,
              height: 16,
              borderRadius: 4,
              background:
                day.isHoliday
                  ? "rgba(251,191,36,0.5)"
                  : day.isWeekend
                    ? "var(--surface-3)"
                    : day.isCurrentWeek
                      ? "rgba(110,168,254,0.5)"
                      : "rgba(52,211,153,0.55)",
            }}
          />
        ))}
      </div>

      {editing ? <PipelineForm item={editing === "new" ? null : editing} people={people} departments={departments} path={path} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function PipelineForm({
  item,
  people,
  departments,
  path,
  onClose,
}: {
  item: ClientPipeline | null;
  people: ClientPerson[];
  departments: ClientDepartment[];
  path: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<PipelineResult, FormData>(savePipelineAction, {});
  const [isTest, setIsTest] = useState(item ? !!item.is_test : false);
  const [status, setStatus] = useState(item?.current_status ?? "Pending");

  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{item ? "Edit recording" : "New recording"}</h2>
            <div className="card-sub">Planned and actual dates stay separate; duration uses the later of each pair.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <form action={formAction}>
          <div className="modal-body">
            <input type="hidden" name="id" value={item?.id ?? ""} />
            <input type="hidden" name="path" value={path} />
            <input type="hidden" name="is_test" value={isTest ? "1" : "0"} />
            <input type="hidden" name="current_status" value={status} />
            <div className="form-grid">
              <div className="field span-2">
                <label>Recording title *</label>
                <input className="input" name="activity" defaultValue={item?.activity ?? ""} required />
              </div>
              <div className="field span-2">
                <label>Detail</label>
                <input className="input" name="detail" defaultValue={item?.detail ?? ""} />
              </div>
              <div className="field">
                <label>Planned start</label>
                <input className="input" type="date" name="planned_start" defaultValue={item?.planned_start ?? ""} />
              </div>
              <div className="field">
                <label>Planned end</label>
                <input className="input" type="date" name="planned_end" defaultValue={item?.planned_end ?? ""} />
              </div>
              <div className="field">
                <label>Actual start</label>
                <input className="input" type="date" name="actual_start" defaultValue={item?.actual_start ?? ""} />
              </div>
              <div className="field">
                <label>Actual end</label>
                <input className="input" type="date" name="actual_end" defaultValue={item?.actual_end ?? ""} />
              </div>
              <div className="field">
                <label>Recording status</label>
                <select className="select" name="recording_status" defaultValue={item?.recording_status ?? "Not started"}>
                  {RECORDING_STATUSES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Current status</label>
                <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Owner</label>
                <select className="select" name="assignee_id" defaultValue="">
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Department</label>
                <select className="select" name="department_id" defaultValue="">
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Automation %</label>
                <input className="input" type="number" min={0} max={100} name="automation_percent" defaultValue={item?.automation_percent ?? 0} />
              </div>
              <div className="field">
                <label>Colour</label>
                <input className="input" type="color" name="colour" defaultValue={item?.colour ?? "#8b5cf6"} style={{ padding: 4, height: 36 }} />
              </div>
              <div className="field span-2">
                <label>Blocker / reason</label>
                <input className="input" name="blocker" defaultValue={item?.blocker ?? ""} placeholder="Required when status is Blocked" />
              </div>
              <div className="field span-2">
                <label>Notes</label>
                <textarea className="textarea" name="notes" defaultValue={item?.notes ?? ""} />
              </div>
              <label className="check span-2">
                <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
                TEST record — demo only, excluded from operational KPIs.
              </label>
            </div>
            {state.error ? (
              <div className="banner bad" style={{ marginTop: 10 }}>
                <Icon name="alert" size={15} /> {state.error}
              </div>
            ) : null}
          </div>
          <div className="modal-foot">
            {item ? (
              <div style={{ marginRight: "auto" }}>
                <button className="btn btn-danger btn-sm" type="submit" formAction={deletePipelineAction}>
                  <Icon name="trash" size={13} /> Delete
                </button>
              </div>
            ) : null}
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save recording"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
