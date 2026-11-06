import { getViewer, canAdmin } from "@/lib/access";
import { all } from "@/lib/db";
import { formatDate, isoToday } from "@/lib/dates";
import { json } from "@/lib/db";
import { appSettings } from "@/lib/settings";
import { aiStatus } from "@/lib/ai";
import { PageHeader, PageGuidance } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { Icon } from "@/components/icons";
import { saveChangelogAction } from "@/app/actions/changelog";

export const dynamic = "force-dynamic";

const TYPE_BADGE: Record<string, string> = {
  feature: "badge-blue",
  fix: "badge-amber",
  merge: "badge-purple",
  pr: "badge-slate",
  security: "badge-red",
};

export default async function ChangelogPage() {
  const viewer = await getViewer();
  const admin = canAdmin(viewer);
  const settings = appSettings();
  const ai = aiStatus();
  const entries = all<any>(`SELECT * FROM changelog WHERE published = 1 ORDER BY date DESC, created_at DESC, rowid DESC`);
  const migrations = all<{ name: string; applied_at: string }>(`SELECT * FROM _migrations ORDER BY name`);
  const tableCount =
    all<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)[0]?.n ?? 0;
  const audit = all<any>(`SELECT * FROM audit_events ORDER BY at DESC LIMIT 10`);
  const demoRows = all<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM activities WHERE is_demo = 1) + (SELECT COUNT(*) FROM bugs WHERE is_demo = 1) AS n`
  )[0]?.n ?? 0;

  return (
    <main className="page">
      <PageHeader
        id="tab.changelog" path="/changelog" canEdit={admin}
        title="What's new"
        description="Every release, merge and PR records its change here — inside the app, next to the feature. Add an entry with each change set."
        meta={
          <>
            {entries.length} published entries · latest {entries[0]?.version ?? "—"} · build {isoToday()}
          </>
        }
      />

      <PageGuidance id="tab.changelog" path="/changelog" canEdit={admin} />

      <Section
        id="sec.changelog.releases"
        tabId="tab.changelog"
        title="Release notes"
        description="Feature, fix, merge, PR and security entries with PR references."
        path="/changelog"
        canEdit={admin}
      >
        <div className="card-pad stack">
          {entries.map((entry) => {
            const items = json<Array<string | { label: string; detail?: string }>>(entry.items, []);
            return (
              <article key={entry.id} style={{ paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="badge badge-slate mono">v{entry.version}</span>
                  <strong style={{ fontSize: "0.98rem" }}>{entry.title}</strong>
                  <span className={`badge ${TYPE_BADGE[entry.type] ?? "badge-slate"}`}>{entry.type}</span>
                  {entry.pr_number ? <span className="badge badge-purple">PR #{entry.pr_number}</span> : null}
                  <span className="card-sub" style={{ marginLeft: "auto" }}>{formatDate(entry.date)}</span>
                </div>
                {entry.summary ? <p className="dim" style={{ fontSize: "0.85rem", marginTop: 6 }}>{entry.summary}</p> : null}
                {items.length ? (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: "0.83rem", color: "var(--text-dim)", lineHeight: 1.65 }}>
                    {items.map((item, index) => {
                      const label = typeof item === "string" ? item : item.label;
                      return label ? <li key={`${entry.id}-${index}`}>{label}</li> : null;
                    })}
                  </ul>
                ) : null}
                {entry.pr_url ? (
                  <a className="card-sub mono" href={entry.pr_url} style={{ display: "inline-block", marginTop: 6 }} rel="noreferrer noopener" target="_blank">
                    {entry.pr_url}
                  </a>
                ) : null}
              </article>
            );
          })}

          {admin ? (
            <details className="card" style={{ padding: "10px 14px" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.84rem", fontWeight: 600 }}>
                <Icon name="plus" size={13} /> Add a change entry (PR / merge)
              </summary>
              <form action={saveChangelogAction} className="form-grid" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>Version</label>
                  <input className="input input-sm" name="version" placeholder="1.1.0" required />
                </div>
                <div className="field">
                  <label>Date</label>
                  <input className="input input-sm" type="date" name="date" defaultValue={isoToday()} />
                </div>
                <div className="field">
                  <label>Type</label>
                  <select className="select select-sm" name="type" defaultValue="feature">
                    {["feature", "fix", "merge", "pr", "security"].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>PR number</label>
                  <input className="input input-sm" type="number" name="pr_number" placeholder="123" />
                </div>
                <div className="field span-2">
                  <label>Title</label>
                  <input className="input input-sm" name="title" required />
                </div>
                <div className="field span-2">
                  <label>Summary</label>
                  <textarea className="textarea" name="summary" style={{ minHeight: 60 }} />
                </div>
                <div className="field span-2">
                  <label>Change list (one per line)</label>
                  <textarea className="textarea" name="items" style={{ minHeight: 70 }} placeholder="Tab toggles respect permissions&#10;Added audit log for capacity edits" />
                </div>
                <div className="field span-2">
                  <label>PR URL</label>
                  <input className="input input-sm" name="pr_url" placeholder="https://github.com/…/pull/123" />
                </div>
                <div className="form-actions span-2">
                  <button className="btn btn-sm btn-primary" type="submit">Publish entry</button>
                </div>
              </form>
            </details>
          ) : null}
        </div>
      </Section>

      <Section
        id="sec.changelog.about"
        tabId="tab.changelog"
        title="Build information"
        description="Schema, configuration and data provenance for this instance."
        path="/changelog"
        canEdit={admin}
      >
        <div className="card-pad grid-2">
          <div>
            <div className="stat-line"><span className="muted">Application</span><span>{settings.appName}</span></div>
            <div className="stat-line"><span className="muted">Latest version</span><span>v{entries[0]?.version ?? "1.0.0"}</span></div>
            <div className="stat-line"><span className="muted">Timezone</span><span>{settings.timezone}</span></div>
            <div className="stat-line"><span className="muted">Fiscal start month</span><span>{settings.fiscalStartMonth}</span></div>
            <div className="stat-line"><span className="muted">Hours per day default</span><span>{settings.hoursPerDay}</span></div>
            <div className="stat-line"><span className="muted">AI provider</span><span>{ai.provider} · {ai.model}</span></div>
            <div className="stat-line"><span className="muted">Database tables</span><span>{tableCount}</span></div>
            <div className="stat-line"><span className="muted">Demo rows flagged</span><span>{demoRows}</span></div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Applied migrations</div>
            <div className="stack-sm">
              {migrations.map((migration) => (
                <div className="row-between" key={migration.name} style={{ fontSize: "0.78rem" }}>
                  <span className="mono">{migration.name}</span>
                  <span className="muted">{String(migration.applied_at).slice(0, 16)}</span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <div className="label" style={{ marginBottom: 6 }}>Recent audit events</div>
            <div className="stack-sm">
              {audit.map((event) => (
                <div className="row-between" key={event.id} style={{ fontSize: "0.76rem" }}>
                  <span>
                    <strong>{event.actor_name ?? "system"}</strong>{" "}
                    <span className="muted">{event.action}</span>
                  </span>
                  <span className="mono muted">{String(event.at).slice(5, 16)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}
