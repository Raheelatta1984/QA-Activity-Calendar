"use client";

import { useActionState, useEffect, useState } from "react";
import { saveActivityAction, deleteActivityAction, type ActionResult } from "@/app/actions/activities";
import type { ClientActivity, ClientDepartment, ClientPerson } from "./types";
import { Icon } from "./icons";

const GROUPS = ["Regression", "Automation", "Performance", "Security", "Integration", "UAT", "Other"];
const STATUSES = ["Planned", "In Progress", "Complete", "Blocked", "Deferred", "Cancelled"];
const PRIORITIES = ["Low", "Normal", "High", "Critical"];

export function ActivityForm({
  activity,
  people,
  departments,
  defaultDate,
  path,
  onClose,
  canEdit = true,
}: {
  activity?: ClientActivity | null;
  people: ClientPerson[];
  departments: ClientDepartment[];
  defaultDate?: string;
  path: string;
  onClose: () => void;
  canEdit?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(saveActivityAction, {});
  const [isActive, setIsActive] = useState(activity ? activity.active === 1 : true);
  const [group, setGroup] = useState(activity?.group ?? "Regression");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={activity ? "Edit activity" : "New activity"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{activity ? "Edit activity" : "New activity"}</h2>
            <div className="card-sub">
              {activity ? (
                <>
                  <span className="mono">{activity.code}</span> · source {activity.source_sheet ?? "app"}
                  {activity.source_row ? ` row ${activity.source_row}` : ""}
                </>
              ) : (
                "Dates are inclusive; duration is end − start + 1 calendar days."
              )}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <form action={formAction}>
          <div className="modal-body stack">
            <input type="hidden" name="id" value={activity?.id ?? ""} />
            <input type="hidden" name="path" value={path} />
            <input type="hidden" name="active" value={isActive ? "1" : "0"} />

            <div className="form-grid">
              <div className="field span-2">
                <label htmlFor="activity">Activity *</label>
                <input
                  id="activity"
                  className="input"
                  name="activity"
                  defaultValue={activity?.activity ?? ""}
                  placeholder="e.g. FY27 Q2 Regression"
                  required
                  autoFocus
                />
              </div>
              <div className="field span-2">
                <label htmlFor="detail">Detail</label>
                <input
                  id="detail"
                  className="input"
                  name="detail"
                  defaultValue={activity?.detail ?? ""}
                  placeholder="Scope, build number or environment"
                />
              </div>

              <div className="field">
                <label htmlFor="activity_group">Activity group</label>
                <select
                  id="activity_group"
                  className="select"
                  name="activity_group"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  {GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="status">Status</label>
                <select id="status" className="select" name="status" defaultValue={activity?.status ?? "Planned"}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="assignee_id">Assignee</label>
                <select id="assignee_id" className="select" name="assignee_id" defaultValue={activity?.assignee_id ?? ""}>
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="department_id">Department</label>
                <select id="department_id" className="select" name="department_id" defaultValue={activity?.department_id ?? ""}>
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="planned_start">Planned start</label>
                <input
                  id="planned_start"
                  type="date"
                  className="input"
                  name="planned_start"
                  defaultValue={activity?.planned_start ?? activity?.start_date ?? defaultDate ?? ""}
                />
              </div>
              <div className="field">
                <label htmlFor="planned_end">Planned end</label>
                <input
                  id="planned_end"
                  type="date"
                  className="input"
                  name="planned_end"
                  defaultValue={activity?.planned_end ?? activity?.end_date ?? defaultDate ?? ""}
                />
              </div>
              <div className="field">
                <label htmlFor="actual_start">Actual start</label>
                <input
                  id="actual_start"
                  type="date"
                  className="input"
                  name="actual_start"
                  defaultValue={activity?.actual_start ?? ""}
                />
              </div>
              <div className="field">
                <label htmlFor="actual_end">Actual end</label>
                <input
                  id="actual_end"
                  type="date"
                  className="input"
                  name="actual_end"
                  defaultValue={activity?.actual_end ?? ""}
                />
              </div>

              <div className="field">
                <label htmlFor="fte">FTE</label>
                <input
                  id="fte"
                  type="number"
                  step="0.1"
                  min="0"
                  max="5"
                  className="input"
                  name="fte"
                  defaultValue={activity?.fte ?? (group === "Regression" ? 1 : 0.5)}
                />
                <span className="card-sub">Default: 1 for Regression, 0.5 otherwise.</span>
              </div>
              <div className="field">
                <label htmlFor="progress_percent">Progress %</label>
                <input
                  id="progress_percent"
                  type="number"
                  min="0"
                  max="100"
                  className="input"
                  name="progress_percent"
                  defaultValue={activity?.progress ?? 0}
                />
                <span className="card-sub">0 means “derive from linked bugs”.</span>
              </div>
              <div className="field">
                <label htmlFor="priority">Priority</label>
                <select id="priority" className="select" name="priority" defaultValue={activity?.priority ?? "Normal"}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rule_type">Rule type</label>
                <input id="rule_type" className="input" name="rule_type" defaultValue={activity?.rule_type ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="code">Calendar item ID</label>
                <input id="code" className="input" name="code" defaultValue={activity?.code ?? ""} placeholder="auto" />
              </div>
              <div className="field">
                <label htmlFor="colour">Colour</label>
                <input
                  id="colour"
                  type="color"
                  className="input"
                  name="colour"
                  defaultValue={activity?.colour ?? "#4f8cff"}
                  style={{ padding: 4, height: 36 }}
                />
              </div>

              <div className="field span-2">
                <label htmlFor="notes">Notes</label>
                <textarea id="notes" className="textarea" name="notes" defaultValue={activity?.notes ?? ""} />
              </div>

              <label className="check span-2">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Active — only Active activities count, display or block pipeline work.
              </label>
            </div>

            {state.error ? (
              <div className="banner bad">
                <Icon name="alert" size={15} /> {state.error}
              </div>
            ) : null}
          </div>

          <div className="modal-foot">
            {activity ? (
              <div style={{ marginRight: "auto", display: "flex", gap: 8 }}>
                {confirmDelete ? (
                  <button className="btn btn-danger btn-sm" type="submit" formAction={deleteActivityAction}>
                    Confirm delete
                  </button>
                ) : (
                  <button className="btn btn-danger btn-sm" type="button" onClick={() => setConfirmDelete(true)}>
                    <Icon name="trash" size={13} /> Delete
                  </button>
                )}
              </div>
            ) : null}
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={pending || !canEdit}>
              {pending ? "Saving…" : activity ? "Save changes" : "Create activity"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
