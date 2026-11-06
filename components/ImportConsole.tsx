"use client";

import { useActionState, useState } from "react";
import { Icon } from "./icons";
import { runImportAction, type ImportState } from "@/app/actions/imports";

export function ImportConsole({ canEdit }: { canEdit: boolean }) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(runImportAction, {});
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("pasted-rows");
  const [mode, setMode] = useState<"dry-run" | "apply">("dry-run");

  return (
    <div className="card card-pad stack">
      <div className="banner info">
        <Icon name="info" size={15} />
        <span>
          Dry-run first. It writes a reconciliation report and changes no activities. Apply is idempotent on the natural
          key (Calendar Item ID / recording code) and records row provenance.
        </span>
      </div>

      <form action={formAction} className="stack">
        <div className="form-grid">
          <div className="field">
            <label>Target table</label>
            <select className="select" name="target" defaultValue="activities">
              <option value="activities">Activities (tblActivities)</option>
              <option value="pipeline">Recording pipeline (tblRecordingPipeline)</option>
            </select>
          </div>
          <div className="field">
            <label>Mode</label>
            <select className="select" name="mode" value={mode} onChange={(e) => setMode(e.target.value as "dry-run" | "apply")}>
              <option value="dry-run">Dry run — reconcile only</option>
              <option value="apply">Apply — write records</option>
            </select>
          </div>
          <div className="field">
            <label>File / batch label</label>
            <input className="input" name="filename" value={filename} onChange={(e) => setFilename(e.target.value)} />
          </div>
          <div className="field">
            <label>Upload a CSV / TSV</label>
            <input
              className="input"
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const content = await file.text();
                setText(content);
                setFilename(file.name);
              }}
            />
          </div>
          <div className="field span-2">
            <label>Source rows (header + records)</label>
            <textarea
              className="textarea"
              name="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Paste CSV or TSV with a header row, e.g.\nCalendar Item ID,Activity,Activity Group,Active Status,Start Date,End Date,FTE,Assing To,Status`}
              style={{ minHeight: 150, fontFamily: "var(--mono)", fontSize: "0.78rem" }}
            />
          </div>
        </div>

        {state.error ? (
          <div className="banner bad">
            <Icon name="alert" size={15} /> {state.error}
          </div>
        ) : null}

        {state.report ? (
          <div className="stack-sm">
            <div className={`banner ${state.report.errors ? "warn" : "good"}`}>
              <Icon name={state.report.errors ? "alert" : "check"} size={15} />
              <span>
                {state.report.mode === "apply" ? "Applied" : "Dry run complete"} · {state.report.total} rows ·{" "}
                {state.report.inserted} inserted · {state.report.updated} updated · {state.report.skipped} skipped ·{" "}
                {state.report.errors} errors
              </span>
              <span className="mono" style={{ marginLeft: "auto", fontSize: "0.7rem" }}>{state.report.batchId}</span>
            </div>

            {state.report.warnings.length ? (
              <details className="card" style={{ padding: "10px 14px" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                  {state.report.warnings.length} warning{state.report.warnings.length === 1 ? "" : "s"} — nothing was
                  silently corrected
                </summary>
                <ul className="insight-evidence" style={{ marginTop: 8 }}>
                  {state.report.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="table-wrap card">
              <table className="data">
                <thead>
                  <tr>
                    <th className="num">Row</th>
                    <th>Key</th>
                    <th>Disposition</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {state.report.rows.map((row, index) => (
                    <tr key={`${row.row}-${index}`}>
                      <td className="num">{row.row}</td>
                      <td className="mono">{row.key ?? "—"}</td>
                      <td>
                        <span
                          className={`badge ${
                            row.status === "inserted"
                              ? "badge-green"
                              : row.status === "updated"
                                ? "badge-blue"
                                : row.status === "error"
                                  ? "badge-red"
                                  : row.status === "conflict"
                                    ? "badge-amber"
                                    : "badge-slate"
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="muted">{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="btn" type="button" onClick={() => setText("")}>
            Clear
          </button>
          <button className={`btn ${mode === "apply" ? "btn-danger" : "btn-primary"}`} type="submit" disabled={pending || !canEdit}>
            <Icon name={mode === "apply" ? "upload" : "eye"} size={14} />
            {pending ? "Processing…" : mode === "apply" ? "Apply import" : "Run dry run"}
          </button>
        </div>
      </form>
    </div>
  );
}
