"use client";

import { useActionState } from "react";
import { saveDecisionAction, type DecisionResult } from "@/app/actions/releases";
import { Icon } from "./icons";

export function DecisionForm({ versions, today }: { versions: string[]; today: string }) {
  const [state, formAction, pending] = useActionState<DecisionResult, FormData>(saveDecisionAction, {});
  return (
    <form action={formAction} className="card card-pad stack-sm">
      <div className="row-between">
        <div>
          <strong style={{ fontSize: "0.9rem" }}>Record a go/no-go decision</strong>
          <div className="card-sub">Audited decision record — a planned status is never treated as approval.</div>
        </div>
        <span className="badge badge-purple">Audited</span>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="version">Release version</label>
          <input id="version" className="input input-sm" name="version" list="release-versions" placeholder="27.4.0" required />
          <datalist id="release-versions">
            {versions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="regression_status">Regression</label>
          <select id="regression_status" className="select select-sm" name="regression_status" defaultValue="Not started">
            {["Not started", "In progress", "Passed", "Failed", "Blocked"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="go_no_go">Decision</label>
          <select id="go_no_go" className="select select-sm" name="go_no_go" defaultValue="Pending">
            {["Pending", "Go", "No-Go", "Conditional Go"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="deployment_status">Deployment</label>
          <select id="deployment_status" className="select select-sm" name="deployment_status" defaultValue="Not deployed">
            {["Not deployed", "Scheduled", "Deploying", "Deployed", "Rolled back"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="decided_at">Decision date</label>
          <input id="decided_at" className="input input-sm" type="date" name="decided_at" defaultValue={today} />
        </div>
        <div className="field span-2">
          <label htmlFor="notes">Evidence / notes</label>
          <input id="notes" className="input input-sm" name="notes" placeholder="Evidence pack reference" />
        </div>
      </div>
      {state.error ? (
        <div className="banner bad">
          <Icon name="alert" size={14} /> {state.error}
        </div>
      ) : null}
      {state.ok ? (
        <div className="banner good">
          <Icon name="check" size={14} /> Decision recorded and added to the audit trail.
        </div>
      ) : null}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn btn-sm btn-primary" type="submit" disabled={pending}>
          {pending ? "Recording…" : "Record decision"}
        </button>
      </div>
    </form>
  );
}
