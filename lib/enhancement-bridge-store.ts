/**
 * SQLite-backed store for the Future Enhancements ↔ GitHub bridge.
 *
 * Implements `BridgeStore` from `lib/enhancement-bridge.ts`. The bridge engine
 * itself never touches SQL, so porting it to another app means writing one file
 * like this against that app's data layer.
 */

import { all, get, run, transaction } from "./db";
import { uid } from "./ids";
import { isoToday } from "./dates";
import { recordAudit } from "./audit";
import { renderEnhancementMarkdown, writeVaultMarkdown, enhancementFileName } from "./enhancements";
import type { BridgeRecord, BridgeStore, GithubIssue } from "./enhancement-bridge";

type EnhancementRow = BridgeRecord & { submitted_by?: string | null; department_id?: string | null; created_at?: string };

function row(id: string): EnhancementRow | undefined {
  return get<EnhancementRow>(
    `SELECT e.*, p.name AS submitted_by_name, d.name AS department_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?`,
    id
  );
}

function nextRef(): string {
  const row = get<{ n: number }>(`SELECT COUNT(*) AS n FROM enhancements`);
  let candidate = (row?.n ?? 0) + 1;
  for (let i = 0; i < 5000; i += 1) {
    const ref = `ENH-${String(candidate).padStart(4, "0")}`;
    if (!get(`SELECT 1 FROM enhancements WHERE ref = ?`, ref)) return ref;
    candidate += 1;
  }
  return `ENH-${Date.now()}`;
}

const UPDATABLE = new Set([
  "title",
  "brief",
  "requirements",
  "impacts",
  "expected_outcome",
  "success_criteria",
  "status",
  "github_repo",
  "github_issue_number",
  "github_issue_url",
  "github_state",
  "github_labels",
  "github_updated_at",
  "github_synced_at",
  "github_direction",
]);

export function bridgeStore(): BridgeStore {
  return {
    list: () => all<EnhancementRow>(`SELECT * FROM enhancements ORDER BY created_at`),
    findByRef: (ref) => get<EnhancementRow>(`SELECT * FROM enhancements WHERE ref = ?`, ref),

    nextRef,

    create({ ref, title, brief, status, repo, issue, labels, actorName }) {
      const id = uid("enh");
      const markdown = renderEnhancementMarkdown({
        ref,
        title,
        status,
        submittedBy: actorName ?? issue.user?.login ?? "GitHub",
        submittedOn: isoToday(),
        rawMarkdown: null,
        brief,
        requirements: null,
        impacts: null,
        expectedOutcome: null,
        successCriteria: null,
      }).body;
      const fileName = enhancementFileName(ref, title);
      const written = writeVaultMarkdown({ fileName, content: markdown });
      run(
        `INSERT INTO enhancements (id, ref, title, brief, markdown, status, github_path, source,
           github_repo, github_issue_number, github_issue_url, github_state, github_labels,
           github_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        id,
        ref,
        title,
        brief,
        markdown,
        status,
        written.relativePath,
        repo,
        issue.number,
        issue.html_url,
        issue.state,
        JSON.stringify(labels)
      );
      recordAudit({
        actorId: null,
        actorName: actorName ?? "GitHub bridge",
        action: "enhancement.github_import",
        entity: "enhancement",
        entityId: id,
        after: { ref, title, repo, issue: issue.number },
      });
      return row(id) as BridgeRecord;
    },

    update(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => UPDATABLE.has(key));
      if (!entries.length) return;
      const sets = entries.map(([key]) => `${key} = ?`).join(", ");
      run(
        `UPDATE enhancements SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
        ...entries.map(([, value]) => (value === undefined ? null : (value as string | number | null))),
        id
      );
    },

    replaceLinks(enhancementId, repo, links) {
      transaction(() => {
        run(`DELETE FROM enhancement_links WHERE enhancement_id = ? AND repo = ?`, enhancementId, repo);
        for (const link of links) {
          run(
            `INSERT INTO enhancement_links (id, enhancement_id, repo, kind, number, url, title, state, merged, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(enhancement_id, repo, kind, number) DO UPDATE SET
               url = excluded.url, title = excluded.title, state = excluded.state,
               merged = excluded.merged, updated_at = datetime('now')`,
            uid("link"),
            enhancementId,
            repo,
            link.kind,
            link.number,
            link.url ?? null,
            link.title ?? null,
            link.state ?? null,
            link.merged ? 1 : 0
          );
        }
      });
    },

    recordEvent(event) {
      run(
        `INSERT INTO enhancement_sync_events
           (id, direction, actor_name, repo, pulled, pushed, created, updated, skipped, errors, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        uid("sync"),
        event.direction,
        event.actorName ?? null,
        event.repo,
        event.pulled,
        event.pushed,
        event.created,
        event.updated,
        event.skipped,
        event.errors.length ? JSON.stringify(event.errors) : null,
        event.detail ? JSON.stringify(event.detail) : null
      );
    },
  };
}

/** Recent bridge runs, newest first — what the panel shows. */
export function recentSyncEvents(limit = 8) {
  return all<{
    id: string;
    direction: string;
    actor_name: string | null;
    repo: string | null;
    pulled: number;
    pushed: number;
    created: number;
    updated: number;
    skipped: number;
    errors: string | null;
    at: string;
  }>(`SELECT * FROM enhancement_sync_events ORDER BY at DESC LIMIT ?`, limit);
}

/** Every remote pointer a proposal has, for the panel. */
export function linksFor(enhancementId: string) {
  return all<{
    kind: string;
    repo: string;
    number: number;
    url: string | null;
    title: string | null;
    state: string | null;
    merged: number;
  }>(
    `SELECT kind, repo, number, url, title, state, merged FROM enhancement_links
      WHERE enhancement_id = ? ORDER BY kind DESC, number DESC`,
    enhancementId
  );
}

/** Link counts for the vault list, so a card can show `#12 · 2 PRs` without N queries. */
export function linkCounts(): Map<string, { issues: number; pulls: number }> {
  const rows = all<{ enhancement_id: string; kind: string; n: number }>(
    `SELECT enhancement_id, kind, COUNT(*) AS n FROM enhancement_links GROUP BY enhancement_id, kind`
  );
  const out = new Map<string, { issues: number; pulls: number }>();
  for (const entry of rows) {
    const current = out.get(entry.enhancement_id) ?? { issues: 0, pulls: 0 };
    if (entry.kind === "issue") current.issues += Number(entry.n);
    if (entry.kind === "pull") current.pulls += Number(entry.n);
    out.set(entry.enhancement_id, current);
  }
  return out;
}

export type BridgeIssueSeed = GithubIssue;
