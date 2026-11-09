import { getViewer, canAdmin, canEdit } from "@/lib/access";
import { setting } from "@/lib/db";
import { listEnhancements, vaultFiles, vaultInfo, readEnhancementMarkdown, enhancementFileName } from "@/lib/enhancements";
import { matchHandoverDoc, scanHandoverDocs, type HandoverDoc } from "@/lib/enhancement-docs";
import { HANDOVER_STATUSES, STATUS_HINTS, pipelineStages } from "@/lib/enhancement-status";
import { bridgeBlockers, readBridgeEnv, resolveBridgeConfig } from "@/lib/enhancement-bridge";
import { linksFor, recentSyncEvents } from "@/lib/enhancement-bridge-store";
import { GithubBridgePanel, type BridgeLinkView, type SyncEventView } from "@/components/GithubBridgePanel";
import { BridgePortabilityKit } from "@/components/BridgePortabilityKit";
import { HandoverDocsPanel, type DocRow } from "@/components/HandoverDocsPanel";
import { formatDate } from "@/lib/dates";
import { Section } from "@/components/Section";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { EnhancementStudio } from "@/components/EnhancementStudio";
import { MarkdownDownload } from "@/components/MarkdownDownload";
import { EnhancementStatusForm } from "@/components/EnhancementStatusForm";
import { Icon } from "@/components/icons";
import { deleteEnhancementAction, regenerateMarkdownAction } from "@/app/actions/enhancements";

export const dynamic = "force-dynamic";

const FLOW = pipelineStages();

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
  const handovers = scanHandoverDocs();
  // The same matcher the reconciliation uses, so the panel and the sync agree
  // about which request a document belongs to (and flag an ambiguous ref).
  const linkDoc = (doc: HandoverDoc): DocRow => {
    const linked = matchHandoverDoc(doc, items);
    return { ...doc, linkedRef: linked?.ref ?? null, linkedStatus: linked?.status ?? null };
  };
  const handoverActive = handovers.active.map(linkDoc);
  const handoverArchived = handovers.archived.map(linkDoc);

  // GitHub bridge (v2): configuration, the remote pointer per proposal and the
  // recent runs. A misconfigured bridge renders as a banner, never an error.
  const bridge = resolveBridgeConfig((key, fallback) => setting(key, fallback));
  const bridgeEnv = readBridgeEnv();
  const bridgeLinks: BridgeLinkView[] = items
    .filter((item) => item.github_issue_number || item.github_repo)
    .map((item) => ({
      ref: item.ref,
      title: item.title,
      status: item.status,
      issueNumber: item.github_issue_number ?? null,
      issueUrl: item.github_issue_url ?? null,
      issueState: item.github_state ?? null,
      pulls: linksFor(item.id)
        .filter((row) => row.kind === "pull")
        .map((row) => ({ number: row.number, url: row.url, state: row.state, merged: Boolean(row.merged) })),
      syncedAt: item.github_synced_at ?? null,
      direction: item.github_direction ?? null,
      source: item.source ?? "app",
    }));
  const bridgeEvents: SyncEventView[] = recentSyncEvents(6).map((event) => ({
    direction: event.direction,
    actor: event.actor_name,
    repo: event.repo,
    pulled: Number(event.pulled),
    pushed: Number(event.pushed),
    created: Number(event.created),
    updated: Number(event.updated),
    skipped: Number(event.skipped),
    errors: event.errors ? JSON.parse(event.errors).length : 0,
    at: event.at,
  }));
  const bridgeRepoName = (process.env.GITHUB_REPOSITORY || "Raheelatta1984/QA-Activity-Calendar").trim();

  return (
    <main className="page">
      <PageHeader
        id="tab.enhancements" path="/enhancements" canEdit={editable}
        title="Future enhancements"
        description="Capture improvement requests inside the app, review them with every change set, and archive the markdown once built and tested so it is never reviewed twice."
        meta={
          <>
            {active.length} active · {archived.length} archived · {files.length} vault file
            {files.length === 1 ? "" : "s"} · {handoverActive.length + handoverArchived.length} handover document
            {handoverActive.length + handoverArchived.length === 1 ? "" : "s"} in{" "}
            <code className="mono">lib/future-enhancements/</code>
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
              <div className="kpi-foot">
                {index === 0 ? "awaiting triage" : stage === "Built" ? "awaiting archive" : "in the pipeline"}
              </div>
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
        description="Building publishes the approved handover to GitHub. Completed handovers are archived after their PR merges."
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
                    <span className={`badge ${STATUS_BADGE[item.status] ?? "badge-slate"}`} title={STATUS_HINTS[item.status]}>
                      {item.status}
                    </span>
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
                  <MarkdownDownload {...readEnhancementMarkdown(item)} />
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
                {HANDOVER_STATUSES.includes(item.status as never) ? (
                  <div className="card-sub mono" style={{ marginTop: 8 }}>
                    GitHub handover: lib/future-enhancements/{enhancementFileName(item.ref, item.title).replace(/\.md$/, "")}-
                    {item.id.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}.md
                  </div>
                ) : null}
                {STATUS_HINTS[item.status] ? (
                  <p className="dim" style={{ fontSize: "0.8rem", marginTop: 8 }}>{STATUS_HINTS[item.status]}</p>
                ) : null}
                {item.github_path ? (
                  <div className="card-sub mono" style={{ marginTop: 8 }}>{item.github_path}</div>
                ) : null}
              </details>

              {editable ? (
                <EnhancementStatusForm id={item.id} status={item.status} />
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
                  Local vault files are not GitHub commits. To commit local proposals, review with
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

      <Section
        id="sec.enhancements.handovers"
        tabId="tab.enhancements"
        title="Handover documents"
        description="The Markdown files in lib/future-enhancements/ and the status each one carries. Building publishes a handover, Built means the implementation merged, and Archived is written once the completion workflow moves the file into archived/."
        path="/enhancements"
        canEdit={editable}
      >
        <HandoverDocsPanel active={handoverActive} archived={handoverArchived} canEdit={editable} />
      </Section>

      <Section
        id="sec.enhancements.github"
        tabId="tab.enhancements"
        title="GitHub bridge (v2) — two-way"
        description="Link this vault to issues in any GitHub repository. Pull imports issues and refreshes linked proposals, push opens or updates the issue for each proposal, and the default two-way run pulls first so neither side overwrites the other."
        path="/enhancements"
        canEdit={editable}
      >
        <GithubBridgePanel
          config={{
            enabled: bridge.enabled,
            repo: bridge.repo,
            label: bridge.label,
            state: bridge.state,
            statusLabelPrefix: bridge.statusLabelPrefix,
            hasToken: bridge.hasToken,
            repoPinnedByEnv: bridge.repoPinnedByEnv,
            blockers: bridgeBlockers(bridge),
            envRepo: bridgeEnv.repo,
          }}
          links={bridgeLinks}
          events={bridgeEvents}
          canEdit={editable}
          canAdmin={canAdmin(viewer)}
        />
      </Section>

      <Section
        id="sec.enhancements.portability"
        tabId="tab.enhancements"
        title="Reuse this in another repository"
        description="The bridge is a self-contained module, not a fork of this app. This is exactly what to copy, and what it needs to run against a different GitHub project."
        path="/enhancements"
        canEdit={editable}
      >
        <BridgePortabilityKit repo={bridgeRepoName} />
      </Section>
    </main>
  );
}
