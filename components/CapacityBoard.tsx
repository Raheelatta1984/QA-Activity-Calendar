"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { saveCapacityAction, bulkCapacityAction } from "@/app/actions/capacity";

export type CapacityPerson = {
  person_id: string;
  name: string;
  colour: string;
  department_name: string;
  working_days: number;
  total_hours: number;
  not_available: number;
  devops: number;
  recording: number;
  qa_testing: number;
  occupied: number;
  utilisation: number;
  fte_demand: number;
  days_without_entry: string[];
  cells: {
    date: string;
    not_available_hours: number;
    devops_hours: number;
    recording_hours: number;
    qa_testing_hours: number;
    total_hours: number;
    note: string | null;
  }[];
};

export function CapacityBoard({
  people,
  days,
  holidays,
  monthKey,
  monthOptions,
  canEdit,
}: {
  people: CapacityPerson[];
  days: string[];
  holidays: Record<string, string>;
  monthKey: string;
  monthOptions: { key: string; label: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [edit, setEdit] = useState<{ person: CapacityPerson; date: string } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const cellFor = (person: CapacityPerson, date: string) => person.cells.find((c) => c.date === date);

  function statusClass(person: CapacityPerson, date: string) {
    if (holidays[date]) return "holiday";
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) return "weekend";
    const cell = cellFor(person, date);
    if (!cell) return "";
    if (cell.not_available_hours >= cell.total_hours) return "full";
    if (cell.total_hours - cell.qa_testing_hours > 0.01) return "partial";
    return "";
  }

  const selectedCell = edit ? cellFor(edit.person, edit.date) : null;

  return (
    <div className="stack">
      <div className="row-between">
        <div className="filters">
          <div className="field">
            <label htmlFor="cap-month">Month</label>
            <select
              id="cap-month"
              className="select select-sm"
              value={monthKey}
              onChange={(e) => router.push(`?month=${e.target.value}`)}
            >
              {monthOptions.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {canEdit ? (
            <button className="btn btn-sm" onClick={() => setBulkOpen(true)}>
              <Icon name="refresh" size={13} /> Set month default hours
            </button>
          ) : null}
        </div>
        <div className="cal-legend">
          <span><span className="legend-swatch" style={{ background: "rgba(110,168,254,0.35)" }} /> partly occupied</span>
          <span><span className="legend-swatch" style={{ background: "rgba(248,113,113,0.4)" }} /> fully unavailable</span>
          <span><span className="legend-swatch" style={{ background: "rgba(251,191,36,0.3)" }} /> holiday</span>
        </div>
      </div>

      <div className="matrix card" style={{ padding: 10 }}>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Person</th>
              {days.map((d) => {
                const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
                return (
                  <th
                    key={d}
                    title={holidays[d] ?? ""}
                    style={{ opacity: weekday === 0 || weekday === 6 ? 0.4 : 1 }}
                  >
                    {d.slice(8)}
                    <div style={{ fontSize: "0.58rem", fontWeight: 400 }}>
                      {["S", "M", "T", "W", "T", "F", "S"][weekday]}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.person_id}>
                <td className="cell-person">
                  <span className="row" style={{ gap: 6 }}>
                    <span className="avatar" style={{ width: 20, height: 20, flex: "0 0 20px", background: person.colour, fontSize: "0.6rem" }}>
                      {person.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                    </span>
                    {person.name}
                  </span>
                </td>
                {days.map((date) => {
                  const cell = cellFor(person, date);
                  const label = holidays[date] ? "H" : cell ? (cell.not_available_hours >= cell.total_hours ? "NA" : String(cell.total_hours)) : "—";
                  return (
                    <td key={date}>
                      <button
                        className={`cell ${statusClass(person, date)}`}
                        title={
                          cell
                            ? `${date} · total ${cell.total_hours}h · QA ${cell.qa_testing_hours}h · DevOps ${cell.devops_hours}h · recording ${cell.recording_hours}h · unavailable ${cell.not_available_hours}h`
                            : `${date} · no capacity entry`
                        }
                        onClick={() => canEdit && setEdit({ person, date })}
                        style={{ cursor: canEdit ? "pointer" : "default" }}
                      >
                        {label}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit ? (
        <div className="modal-backdrop" onClick={() => setEdit(null)}>
          <div className="modal" style={{ width: "min(520px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>Capacity · {edit.person.name}</h2>
                <div className="card-sub">{edit.date}{holidays[edit.date] ? ` · ${holidays[edit.date]}` : ""}</div>
              </div>
              <button className="icon-btn" onClick={() => setEdit(null)} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <form action={saveCapacityAction}>
              <div className="modal-body">
                <input type="hidden" name="person_id" value={edit.person.person_id} />
                <input type="hidden" name="date" value={edit.date} />
                <input type="hidden" name="path" value="/capacity" />
                <div className="form-grid">
                  <div className="field">
                    <label>Total hours</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      min="0"
                      name="total_hours"
                      defaultValue={selectedCell?.total_hours ?? edit.person.total_hours / Math.max(1, edit.person.working_days)}
                    />
                  </div>
                  <div className="field">
                    <label>Not available</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      min="0"
                      name="not_available_hours"
                      defaultValue={selectedCell?.not_available_hours ?? 0}
                    />
                  </div>
                  <div className="field">
                    <label>DevOps time</label>
                    <input className="input" type="number" step="0.1" min="0" name="devops_hours" defaultValue={selectedCell?.devops_hours ?? 0} />
                  </div>
                  <div className="field">
                    <label>Recording &amp; maintenance</label>
                    <input className="input" type="number" step="0.1" min="0" name="recording_hours" defaultValue={selectedCell?.recording_hours ?? 0} />
                  </div>
                  <div className="field">
                    <label>QA testing</label>
                    <input className="input" type="number" step="0.1" min="0" name="qa_testing_hours" defaultValue={selectedCell?.qa_testing_hours ?? 0} />
                  </div>
                  <div className="field span-2">
                    <label>Note</label>
                    <input className="input" name="note" defaultValue={selectedCell?.note ?? ""} placeholder="e.g. leave, training, incident" />
                  </div>
                </div>
                <div className="card-sub" style={{ marginTop: 10 }}>
                  Occupied = unavailable + DevOps + recording + QA. Total hours are never assumed to be 8 — the source
                  used 7.6 or 4-hour days.
                </div>
              </div>
              <div className="modal-foot">
                <button className="btn" type="button" onClick={() => setEdit(null)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit">
                  Save hours
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {bulkOpen ? (
        <div className="modal-backdrop" onClick={() => setBulkOpen(false)}>
          <div className="modal" style={{ width: "min(460px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Set month default hours</h2>
              <button className="icon-btn" onClick={() => setBulkOpen(false)} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <form action={bulkCapacityAction}>
              <div className="modal-body stack-sm">
                <input type="hidden" name="month" value={monthKey} />
                <input type="hidden" name="path" value="/capacity" />
                <div className="field">
                  <label>Total hours per working day</label>
                  <select className="select" name="total_hours" defaultValue="7.6">
                    <option value="7.6">7.6 hours (source default)</option>
                    <option value="4">4 hours (part day)</option>
                    <option value="8">8 hours (only if approved)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Apply to</label>
                  <select className="select" name="person_id" defaultValue="">
                    <option value="">Everyone in scope</option>
                    {people.map((p) => (
                      <option key={p.person_id} value={p.person_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="banner info">
                  <Icon name="info" size={15} /> Weekdays only. Existing entries keep their other categories.
                </div>
              </div>
              <div className="modal-foot">
                <button className="btn" type="button" onClick={() => setBulkOpen(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit">
                  Apply
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
