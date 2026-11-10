import fs from "node:fs";
import path from "node:path";
import { getViewer, canEdit } from "@/lib/access";
import { all } from "@/lib/db";
import { listBatches } from "@/lib/import";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { ImportConsole } from "@/components/ImportConsole";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const viewer = await getViewer();
  const editable = canEdit(viewer);
  const batches = listBatches(15, viewer.org.company.id);
  const rows = all<any>(
    `SELECT * FROM import_rows WHERE batch_id IN (
       SELECT id FROM import_batches WHERE company_id = ? ORDER BY created_at DESC LIMIT 3
     ) ORDER BY row_number LIMIT 40`,
    viewer.org.company.id
  );
  const notesArchived = all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM original_notes_archive WHERE company_id = ?`,
    viewer.org.company.id
  )[0]?.n ?? 0;

  const samplePath = path.join(process.cwd(), "data", "sample-activities.csv");
  const sample = fs.existsSync(samplePath) ? fs.readFileSync(samplePath, "utf8") : "";

  return (
    <main className="page">
      <PageHeader
        id="tab.imports" path="/imports" canEdit={editable}
        title="Import centre"
        description="Reconcile the source workbook without modifying it. Dry-run reports every row's disposition; apply is idempotent and keeps provenance."
        meta={
          <>
            {batches.length} recent batches · {rows.length} recorded row dispositions · {notesArchived} narrative notes
            archived verbatim
          </>
        }
      />

      <PageGuidance id="tab.imports" path="/imports" canEdit={editable} />

      <Section
        id="sec.imports.run"
        tabId="tab.imports"
        title="Run an import"
        description="CSV or TSV. Column headers are matched against source aliases, including the workbook spelling 'Assing To'."
        path="/imports"
        canEdit={editable}
        bare
      >
        <ImportConsole
          canEdit={editable}
          departments={viewer.org.departments
            .filter((department) => viewer.departmentIds.has(department.id))
            .map((department) => ({ id: department.id, name: department.name }))}
        />
      </Section>

      <Section
        id="sec.imports.history"
        tabId="tab.imports"
        title="Batch history"
        description="Every batch keeps its counts, mode and per-row outcomes so an import can be audited or replayed."
        path="/imports"
        canEdit={editable}
      >
        <div className="card-pad stack">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>File</th>
                  <th>Mode</th>
                  <th className="num">Rows</th>
                  <th className="num">Inserted</th>
                  <th className="num">Updated</th>
                  <th className="num">Skipped</th>
                  <th className="num">Errors</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="mono" style={{ fontSize: "0.7rem" }}>{batch.id.slice(-8)}</td>
                    <td>{batch.filename}</td>
                    <td>
                      <span className={`badge ${batch.mode === "apply" ? "badge-purple" : "badge-slate"}`}>{batch.mode}</span>
                    </td>
                    <td className="num">{batch.rows_total}</td>
                    <td className="num">{batch.inserted}</td>
                    <td className="num">{batch.updated}</td>
                    <td className="num">{batch.skipped}</td>
                    <td className="num">{batch.errors}</td>
                    <td>
                      <span className={`badge ${batch.status === "complete" ? "badge-green" : batch.status === "failed" ? "badge-red" : "badge-amber"}`}>
                        {batch.status}
                      </span>
                    </td>
                    <td className="mono nowrap">{String(batch.created_at).slice(0, 16)}</td>
                  </tr>
                ))}
                {!batches.length ? (
                  <tr>
                    <td colSpan={10}><div className="empty">No imports yet — try the sample file below.</div></td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <details className="card" style={{ padding: "10px 14px" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
              Sample source file (data/sample-activities.csv)
            </summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.74rem", color: "var(--text-dim)", marginTop: 8 }}>{sample}</pre>
            <div className="card-sub" style={{ marginTop: 8 }}>
              Copy this into the textarea above, or run <code className="mono">npm run import -- data/sample-activities.csv</code>{" "}
              from the CLI.
            </div>
          </details>

          <div className="banner info">
            <Icon name="shield" size={15} />
            <span>
              Free-text narrative notes longer than 40 characters are copied into the archive table rather than converted
              into invented activity records. Unknown dates remain NULL and appear in Data Quality.
            </span>
          </div>
        </div>
      </Section>
    </main>
  );
}
