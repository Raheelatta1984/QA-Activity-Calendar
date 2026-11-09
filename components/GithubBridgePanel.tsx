"use client";

import { useActionState } from "react";
import { Icon } from "./icons";
import {
  pullEnhancementsAction,
  pushEnhancementsAction,
  saveBridgeConfigAction,
  syncEnhancementsBothWaysAction,
  type BridgeConfigResult,
  type BridgeResult,
} from "@/app/actions/enhancement-bridge";

export type BridgeConfigView = {
  enabled: boolean;
  repo: string;
  label: string;
  state: string;
  statusLabelPrefix: string;
  hasToken: boolean;
  repoPinnedByEnv: boolean;
  blockers: string[];
  envRepo: string;
};

export type BridgeLinkView = {
  ref: string;
  title: string;
  status: string;
  issueNumber: number | null;
  issueUrl: string | null;
  issueState: string | null;
  pulls: Array<{ number: number; url: string | null; state: string | null; merged: boolean }>;
  syncedAt: string | null;
  direction: string | null;
  source: string;
};

export type SyncEventView = {
  direction: string;
  actor: string | null;
  repo: string | null;
  pulled: number;
  pushed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  at: string;
};

function Result({ state, pending }: { state: BridgeResult; pending: boolean }) {
  if (pending) {
    return (
      <div className="banner info">
        <Icon name="refresh" size={15} />
        <span>Talking to GitHub…</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="banner bad" role="alert">
        <Icon name="alert" size={15} />
        <span>{state.error}</span>
      </div>
    );
  }
  if (!state.report) return null;
  const errors = state.report.errors;
  return (
    <div className="stack-sm">
      <div className={`banner ${errors.length ? "warn" : "good"}`} role="status">
        <Icon name={errors.length ? "alert" : "check"} size={15} />
        <span>{state.summary}</span>
      </div>
      {state.report.items.length ? (
        <details open={errors.length > 0}>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem" }}>
            {state.report.items.length} item{state.report.items.length === 1 ? "" : "s"} in this run
          </summary>
          <div className="stack-sm" style={{ marginTop: 8 }}>
            {state.report.items.map((item, index) => (
              <div className="row" key={`${item.ref}-${index}`} style={{ gap: 8, fontSize: "0.78rem" }}>
                <span className={`badge ${item.action === "error" ? "badge-red" : item.action === "unchanged" ? "badge-slate" : item.action === "created" ? "badge-green" : "badge-blue"}`}>
                  {item.action}
                </span>
                <span className="mono">{item.ref}</span>
                {item.issueNumber ? (
                  <span className="badge badge-slate mono">
                    {item.repo}#{item.issueNumber}
                  </span>
                ) : null}
                <span className="dim">{item.message}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ActionButtons({ disabled, reason }: { disabled: boolean; reason: string }) {
  const [syncState, syncAction, syncPending] = useActionState<BridgeResult, FormData>(syncEnhancementsBothWaysAction, {});
  const [pullState, pullAction, pullPending] = useActionState<BridgeResult, FormData>(pullEnhancementsAction, {});
  const [pushState, pushAction, pushPending] = useActionState<BridgeResult, FormData>(pushEnhancementsAction, {});
  const pending = syncPending || pullPending || pushPending;
  const state = syncState.report || syncState.error ? syncState : pullState.report || pullState.error ? pullState : pushState;

  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 8 }}>
        <form action={syncAction}>
          <button className="btn btn-primary btn-sm" type="submit" disabled={pending || disabled} title={disabled ? reason : undefined}>
            <Icon name="refresh" size={13} /> {syncPending ? "Syncing…" : "Sync both ways"}
          </button>
        </form>
        <form action={pullAction}>
          <button className="btn btn-sm" type="submit" disabled={pending || disabled} title={disabled ? reason : "GitHub → app: import and refresh issues"}>
            <Icon name="gitPull" size={13} /> {pullPending ? "Pulling…" : "Pull from GitHub"}
          </button>
        </form>
        <form action={pushAction}>
          <button className="btn btn-sm" type="submit" disabled={pending || disabled} title={disabled ? reason : "App → GitHub: open or update issues"}>
            <Icon name="gitPush" size={13} /> {pushPending ? "Pushing…" : "Push to GitHub"}
          </button>
        </form>
      </div>
      <Result state={state} pending={pending} />
    </div>
  );
}

export function GithubBridgePanel({
  config,
  links,
  events,
  canEdit,
  canAdmin,
}: {
  config: BridgeConfigView;
  links: BridgeLinkView[];
  events: SyncEventView[];
  canEdit: boolean;
  canAdmin: boolean;
}) {
  const [configState, configAction, configPending] = useActionState<BridgeConfigResult, FormData>(saveBridgeConfigAction, {});
  const linked = links.filter((link) => link.issueNumber);
  const unlinked = links.filter((link) => !link.issueNumber);

  return (
    <div className="card-pad stack">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className={`badge ${config.repo ? (config.blockers.length ? "badge-amber" : "badge-green") : "badge-slate"}`}>
          <Icon name="branch" size={11} /> {config.repo || "no repository configured"}
        </span>
        <span className={`badge ${config.hasToken ? "badge-green" : "badge-red"}`}>
          {config.hasToken ? "token present" : "GITHUB_TOKEN missing"}
        </span>
        <span className="badge badge-slate">{linked.length} linked</span>
        {unlinked.length ? <span className="badge badge-blue">{unlinked.length} only in the app</span> : null}
        <span className="badge badge-slate">{config.label ? `label: ${config.label}` : "no label filter"}</span>
      </div>

      {config.blockers.length ? (
        <div className="banner warn">
          <Icon name="alert" size={15} />
          <span>{config.blockers.join(" ")}</span>
        </div>
      ) : (
        <div className="banner info">
          <Icon name="branch" size={15} />
          <span>
            Two-way: start in the app <em>or</em> open an issue in <code className="mono">{config.repo}</code> — pulling brings
            it in, pushing writes the app&apos;s version back. The default run pulls first, so an edit made on GitHub is never
            overwritten by an older local copy.
          </span>
        </div>
      )}

      {canEdit ? (
        <ActionButtons disabled={config.blockers.length > 0} reason={config.blockers.join(" ")} />
      ) : (
        <div className="banner warn">Read-only access: linking is disabled for your role.</div>
      )}

      <div className="grid-2">
        <div>
          <div className="label">Linked issues</div>
          {linked.length ? (
            <div className="stack-sm">
              {linked.map((link) => (
                <article className="card" key={link.ref} style={{ padding: 12 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mono" style={{ fontSize: "0.74rem", color: "var(--muted)" }}>{link.ref}</span>
                    <strong style={{ fontSize: "0.88rem" }}>{link.title}</strong>
                    <span className={`badge ${link.issueState === "closed" ? "badge-slate" : "badge-blue"}`}>
                      #{link.issueNumber} {link.issueState}
                    </span>
                    {link.source === "github" ? <span className="badge badge-purple">from GitHub</span> : null}
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    {link.issueUrl ? (
                      <a className="badge badge-slate mono" href={link.issueUrl} target="_blank" rel="noreferrer">
                        open issue ↗
                      </a>
                    ) : null}
                    {link.pulls.map((pull) => (
                      <a
                        className={`badge ${pull.merged ? "badge-green" : "badge-purple"} mono`}
                        key={pull.number}
                        href={pull.url ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PR #{pull.number} {pull.merged ? "merged" : pull.state}
                      </a>
                    ))}
                    {link.syncedAt ? (
                      <span className="badge badge-slate">
                        {link.direction === "push" ? "pushed" : "pulled"} {link.syncedAt.slice(0, 16).replace("T", " ")} UTC
                      </span>
                    ) : (
                      <span className="badge badge-amber">never synced</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty" style={{ marginTop: 6 }}>
              Nothing is linked yet. Push to open an issue per proposal, or pull with the label filter to import existing
              issues.
            </div>
          )}
        </div>

        <div>
          <div className="label">Recent bridge runs</div>
          {events.length ? (
            <div className="stack-sm">
              {events.map((event, index) => (
                <div className="row" key={`${event.at}-${index}`} style={{ gap: 8, fontSize: "0.78rem" }}>
                  <span className={`badge ${event.errors ? "badge-amber" : "badge-green"}`}>{event.direction}</span>
                  <span className="mono dim">{event.at.slice(0, 16).replace("T", " ")}</span>
                  <span className="dim">
                    {event.created} created · {event.updated} updated · {event.skipped} unchanged
                    {event.errors ? ` · ${event.errors} error${event.errors === 1 ? "" : "s"}` : ""}
                  </span>
                  {event.actor ? <span className="badge badge-slate">{event.actor}</span> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty" style={{ marginTop: 6 }}>No bridge runs recorded yet.</div>
          )}
        </div>
      </div>

      {canAdmin ? (
        <details>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem" }}>Bridge configuration</summary>
          <form action={configAction} style={{ marginTop: 10 }}>
            <div className="form-grid">
              <div className="field span-2">
                <label htmlFor="bridge-repo">GitHub repository</label>
                <input
                  className="input mono"
                  id="bridge-repo"
                  name="repo"
                  placeholder="owner/name or https://github.com/owner/name"
                  defaultValue={config.repo}
                  disabled={config.repoPinnedByEnv}
                />
                {config.repoPinnedByEnv ? (
                  <span className="card-sub">
                    Pinned by <code className="mono">GITHUB_ENHANCEMENTS_REPO</code> ({config.envRepo}). Unset it to choose a
                    repository here.
                  </span>
                ) : (
                  <span className="card-sub">
                    Any repository your token can read and write — this is what makes the module reusable across projects.
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="bridge-label">Import label</label>
                <input className="input mono" id="bridge-label" name="label" defaultValue={config.label} placeholder="future-enhancement" />
                <span className="card-sub">Only issues with this label are pulled in. Empty imports every issue.</span>
              </div>
              <div className="field">
                <label htmlFor="bridge-state">Issue state to import</label>
                <select className="select" id="bridge-state" name="state" defaultValue={config.state}>
                  <option value="all">Open and closed</option>
                  <option value="open">Open only</option>
                  <option value="closed">Closed only</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="bridge-prefix">Status label prefix</label>
                <input className="input mono" id="bridge-prefix" name="status_label_prefix" defaultValue={config.statusLabelPrefix} />
                <span className="card-sub">
                  Mirrored as <code className="mono">{config.statusLabelPrefix}building</code>,{" "}
                  <code className="mono">{config.statusLabelPrefix}built</code>, …
                </span>
              </div>
              <div className="field">
                <label>Availability</label>
                <label className="check">
                  <input type="checkbox" name="enabled" defaultChecked={config.enabled} /> Bridge enabled
                </label>
              </div>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={configPending}>
                {configPending ? "Saving…" : "Save bridge configuration"}
              </button>
            </div>
            {configState.error ? <div className="banner bad" role="alert">{configState.error}</div> : null}
            {configState.ok ? <div className="banner good" role="status">Bridge configuration saved.</div> : null}
          </form>
        </details>
      ) : null}
    </div>
  );
}
