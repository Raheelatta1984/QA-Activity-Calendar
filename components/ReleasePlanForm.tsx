"use client";

import { useActionState } from "react";
import { saveReleasePlanAction, type ReleasePlanResult } from "@/app/actions/releases";
import { Icon } from "./icons";

export type ReleasePlanPerson = {
  id: string;
  name: string;
  title: string | null;
  colour: string;
  department_name: string;
  /** Current FTE share, or null when the person is not assigned to this release. */
  fte: number | null;
};

export type ReleasePlanTarget = {
  id: string;
  version: string;
  qa_start_date: string | null;
  qa_end_date: string | null;
  people: ReleasePlanPerson[];
  /** Default FTE offered for a newly ticked assignee. */
  defaultFte: number;
};

/**
 * Per-release planner: QA window (from → to) plus the assignees and their FTE
 * share. Submitting re-derives the release FTE, the QA-calendar bar and the FTE
 * calendar rows in one step.
 */
export function ReleasePlanForm({ release }: { release: ReleasePlanTarget }) {
  const [state, formAction, pending] = useActionState<ReleasePlanResult, FormData>(saveReleasePlanAction, {});
  const assigned = release.people.filter((person) => person.fte !== null).length;

  return (
    <details className="card" style={{ padding: "10px 14px" }} id={`release-plan-${release.id}`}>
      <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
        <Icon name="edit" size={13} /> Plan QA window &amp; assignees
        <span className="badge badge-slate" style={{ marginLeft: 8 }}>
          {release.qa_start_date && release.qa_end_date
            ? `${release.qa_start_date} → ${release.qa_end_date}`
            : "no window"}
        </span>
        <span className="badge badge-purple" style={{ marginLeft: 6 }}>
          {assigned} assignee{assigned === 1 ? "" : "s"}
        </span>
      </summary>

      <form action={formAction} className="stack" style={{ marginTop: 12 }}>
        <input type="hidden" name="id" value={release.id} />

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`qa-start-${release.id}`}>QA window from</label>
            <input
              id={`qa-start-${release.id}`}
              className="input input-sm"
              type="date"
              name="qa_start_date"
              defaultValue={release.qa_start_date ?? ""}
            />
          </div>
          <div className="field">
            <label htmlFor={`qa-end-${release.id}`}>QA window to</label>
            <input
              id={`qa-end-${release.id}`}
              className="input input-sm"
              type="date"
              name="qa_end_date"
              defaultValue={release.qa_end_date ?? ""}
            />
          </div>
        </div>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Assignees and FTE <span className="muted">— FTE is per working day; FTE-days = FTE × working days</span>
          </div>
          <div className="assignee-grid">
            {release.people.map((person) => {
              const checked = person.fte !== null;
              return (
                <label
                  key={person.id}
                  className={`assignee-row ${checked ? "is-assigned" : ""}`}
                  htmlFor={`person-${release.id}-${person.id}`}
                >
                  <input
                    id={`person-${release.id}-${person.id}`}
                    type="checkbox"
                    name={`person_${person.id}`}
                    defaultChecked={checked}
                  />
                  <span className="legend-swatch" style={{ background: person.colour, flex: "0 0 8px" }} />
                  <span className="assignee-name">
                    <strong>{person.name}</strong>
                    <span className="card-sub" style={{ fontSize: "0.66rem" }}>
                      {person.title ?? "—"} · {person.department_name}
                    </span>
                  </span>
                  <input
                    className="input input-sm assignee-fte"
                    type="number"
                    min={0.05}
                    max={5}
                    step={0.05}
                    name={`fte_${person.id}`}
                    defaultValue={person.fte ?? release.defaultFte}
                    aria-label={`${person.name} FTE`}
                  />
                  <span className="card-sub" style={{ fontSize: "0.66rem" }}>
                    FTE
                  </span>
                </label>
              );
            })}
            {!release.people.length ? (
              <div className="empty">No people are in your visibility scope, so nobody can be assigned.</div>
            ) : null}
          </div>
        </div>

        {state.error ? (
          <div className="banner bad">
            <Icon name="alert" size={14} /> {state.error}
          </div>
        ) : null}
        {state.ok ? (
          <div className="banner good">
            <Icon name="check" size={14} /> {state.message ?? "Release plan saved."}
          </div>
        ) : null}

        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="btn btn-sm btn-primary" type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save window & assignees"}
          </button>
          <span className="card-sub">
            Clearing both dates removes the release from the QA and FTE calendars. Assignees stay for next time.
          </span>
        </div>
      </form>
    </details>
  );
}
