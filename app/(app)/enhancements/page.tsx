import { getViewer, canEdit } from "@/lib/access";
import { listEnhancements, vaultFiles, vaultInfo } from "@/lib/enhancements";
import { formatDate } from "@/lib/dates";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { EnhancementStudio } from "@/components/EnhancementStudio";
import { Icon } from "@/components/icons";
import { setEnhancementStatusAction, deleteEnhancementAction, regenerateMarkdownAction } from "@/app/actions/enhancements";

export const dynamic = "force-dynamic";

const FLOW = ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived"] as const;

/** Fields the author accepted from the assistant, stored as JSON on the record. */
function parseAiFields(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const STATUS_BADGE: Record<string, string> = {
  Submitted: "badge-blue",
  Reviewing: "badge-amber",
  Accepted: "badge-purple",
  Building: "badge-blue",
  Built: "badge-green",
  Archived: "badge-slate",
  Rejected: "badge-red",
};

export default async function EnhancementsPage() {
  const viewer = await getViewer();
  const editable = canEdit(viewer);
  const items = listEnhancements();
  const files = vaultFiles();
  const vault = vaultInfo();
  const active = items.filter((i) => !["Archived", "Rejected"].includes(i.status));
  const archived = items.filter((i) => ["Archived", "Rejected"].includes(i.status));

  return (
    <main className="page">
      <PageHeader
        id="tab.enhancements" path="/enhancements" canEdit={editable}
        title="Future enhancements"
        description="Capture improvement requests inside the app, review them with every change set, and archive the markdown once built and tested so it is never reviewed twice."
        meta={
          <>
            {active.length} active · {archived.length} archived · {files.length} markdown file
            {files.length === 1 ? "" : "s"} in <code className="mono">enhancements/</code>
          </>
        }
      />

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {FLOW.slice(0, 5).map((stage, index) => {
          const count = items.filter((i) => i.status === stage).length;
          return (
            <div className="kpi" key={stage} style={{ ["--kpi-accent" as string]: index === 0 ? "var(--brand)" : "var(--purple)" }}>
              <div className="kpi-label">{stage}</div>
              <div className="kpi-value">{count}</div>
              <div className="kpi-foot">{index === 0 ? "awaiting triage" : "in the pipeline"}</div>
            </div>
          );
        })}
      </div>

      <PageGuidance id="tab.enhancements" path="/enhancements" canEdit={editable} />

      <Section
        id="sec.enhancements.intake"
        tabId="tab.enhancements"
        title="Submit a proposal"
        description="Title, brief, requirements, impacts, expected outcome and success criteria. The assistant drafts the structure; every field stays editable."
        path="/enhancements"
        canEdit={editable}
        bare
      >
        <EnhancementStudio
          departments={viewer.org.departments
            .filter((d) => viewer.departmentIds.has(d.id))
            .map((d) => ({ id: d.id, name: d.name }))}
          canEdit={editable}
        />
      </Section>

      <Section
        id="sec.enhancements.vault"
        tabId="tab.enhancements"
        title="Enhancement vault"
        description="Each proposal keeps its markdown in the repository. Moving to Archived relocates the file to enhancements/archive/."
        path="/enhancements"
        canEdit={editable}
      >
        <div className="card-pad stack">
          <div className="row" style={{ gap: 6 }}>
            {FLOW.map((stage, index) => (
              <span key={stage} className="row" style={{ gap: 6 }}>
                <span className={`badge ${STATUS_BADGE[stage]}`}>
                  {stage} · {items.filter((i) => i.status === stage).length}
                </span>
                {index < FLOW.length - 1 ? <Icon name="chevronRight" size={11} /> : null}
              </span>
            ))}
          </div>

          {items.map((item) => (
            <article className="card" key={item.id} style={{ padding: 14 }}>
              <div className="row-between" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mono" style={{ fontSize: "0.74rem", color: "var(--muted)" }}>{item.ref}</span>
                    <strong style={{ fontSize: "0.94rem" }}>{item.title}</strong>
                    <span className={`badge ${STATUS_BADGE[item.status] ?? "badge-slate"}`}>{item.status}</span>
                  </div>
                  <p className="dim" style={{ fontSize: "0.83rem", marginTop: 4 }}>
                    {item.brief}
                  </p>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <span className="badge badge-slate">
                      <Icon name="user" size={11} /> {item.submitted_by_name ?? "Unknown"}
                    </span>
                    {item.department_name ? <span className="badge badge-slate">{item.department_name}</span> : null}
                    <span className="badge badge-slate">{formatDate(item.created_at.slice(0, 10))}</span>
                    {item.ai_fields ? (
                      <span
                        className="badge badge-purple"
                        title={`Drafted by the local assistant: ${parseAiFields(item.ai_fields).join(", ")}`}
                      >
                        <Icon name="sparkles" size={11} /> AI-drafted: {parseAiFields(item.ai_fields).slice(0, 3).join(", ")}
                        {parseAiFields(item.ai_fields).length > 3 ? ` +${parseAiFields(item.ai_fields).length - 3}` : ""}
                      </span>
                    ) : null}
                    {item.github_path ? (
                      <span className="badge badge-green" title={item.github_path}>
                        <Icon name="branch" size={11} /> markdown
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <a className="btn btn-sm" href={`/api/enhancements/${item.id}`} title="Download markdown">
                    <Icon name="download" size={13} />
                  </a>
                  {editable ? (
                    <>
                      <form action={regenerateMarkdownAction}>
                        <input type="hidden" name="id" value={item.id} />
                        <button className="btn btn-sm" type="submit" title="Rewrite markdown file">
                          <Icon name="refresh" size={13} />
                        </button>
                      </form>
                      <form action={deleteEnhancementAction}>
                        <input type="hidden" name="id" value={item.id} />
                        <button className="btn btn-sm btn-danger" type="submit" title="Delete">
                          <Icon name="trash" size={13} />
                        </button>
                      </form>
                    </>
                  ) : null}
                </div>
              </div>

              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", fontSize: "0.78rem", color: "var(--muted)" }}>
                  Requirements, impacts and success criteria
                </summary>
                <div className="grid-3" style={{ marginTop: 10 }}>
                  <div>
                    <div className="label">Requirements</div>
                    <pre className="card-sub" style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem" }}>{item.requirements ?? "—"}</pre>
                  </div>
                  <div>
                    <div className="label">Impacts</div>
                    <pre className="card-sub" style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem" }}>{item.impacts ?? "—"}</pre>
                  </div>
                  <div>
                    <div className="label">Success criteria</div>
                    <pre className="card-sub" style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem" }}>{item.success_criteria ?? "—"}</pre>
                  </div>
                </div>
                {item.expected_outcome ? (
                  <p className="dim" style={{ fontSize: "0.8rem", marginTop: 8 }}>
                    <strong>Expected outcome:</strong> {item.expected_outcome}
                  </p>
                ) : null}
                {item.github_path ? (
                  <div className="card-sub mono" style={{ marginTop: 8 }}>{item.github_path}</div>
                ) : null}
              </details>

              {editable ? (
                <form action={setEnhancementStatusAction} className="row" style={{ marginTop: 10, gap: 6 }}>
                  <input type="hidden" name="id" value={item.id} />
                  <select className="select select-sm" name="status" defaultValue={item.status} style={{ maxWidth: 160 }}>
                    {[...FLOW, "Rejected"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <button className="btn btn-sm" type="submit">Move stage</button>
                  <span className="card-sub">
                    Archiving moves the markdown to <code className="mono">enhancements/archive/</code>.
                  </span>
                </form>
              ) : null}
            </article>
          ))}
          {!items.length ? <div className="empty">No enhancement requests yet — submit the first one above.</div> : null}

          <div className="banner info">
            <Icon name="branch" size={15} />
            <span>
              {vault.ephemeral ? (
                <>
                  Running on a read-only deployment bundle: proposals are saved to this instance&apos;s writable{" "}
                  <code className="mono">/tmp</code> vault and can be downloaded as frontmatter Markdown from each card to
                  commit into <code className="mono">enhancements/</code>.
                </>
              ) : (
                <>
                  Vault files are normal Markdown in this repository, so every change set can be reviewed with
                  <code className="mono"> git log -- enhancements/</code>. To push from CI or a workstation:
                  <code className="mono"> git add enhancements && git commit -m &quot;docs: enhancement vault&quot; && git push</code>.
                </>
              )}
            </span>
          </div>

          {files.length ? (
            <details>
              <summary style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                {files.length} file{files.length === 1 ? "" : "s"} in the vault
              </summary>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                {files.map((file) => (
                  <span key={file} className="badge badge-slate mono" style={{ fontSize: "0.66rem" }}>
                    {file}
                  </span>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </Section>
    </main>
  );
}
