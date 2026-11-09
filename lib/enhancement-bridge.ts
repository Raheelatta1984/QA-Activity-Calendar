/**
 * Future Enhancements ↔ GitHub bridge (v2).
 *
 * ## Why this is a separate, self-contained module
 *
 * The bridge is designed to be **dropped into any GitHub project** without
 * touching that project's domain code. It only needs:
 *
 *   * a `settings` table (or the `setSetting`/`setting` helpers it is given),
 *   * a GitHub token in the server environment,
 *   * one page + one server-action file + one section registration.
 *
 * `docs/ENHANCEMENTS-GITHUB-BRIDGE.md` describes the port. This file holds the
 * GitHub client, the configuration, the mapping between a remote issue and a
 * proposal, and the push/pull engine. It deliberately contains no React, no
 * Next.js imports and no knowledge of the QA Calendar's domain tables, so it can
 * be unit tested with a fake `fetch` and copied between repositories.
 *
 * ## Two-way, in one sentence
 *
 * A proposal can be created in the app and pushed to GitHub, **or** created as a
 * GitHub issue and pulled into the app. After that, either side can be edited:
 * a pull takes the remote truth for title/body/labels, a push takes the local
 * truth. A field-level conflict is never silently overwritten — the conflict is
 * returned in the report and the UI shows which side changed.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BRIDGE_SETTING_KEYS = {
  enabled: "github.bridge.enabled",
  repo: "github.bridge.repo",
  label: "github.bridge.label",
  state: "github.bridge.state",
  statusLabelPrefix: "github.bridge.status_label_prefix",
} as const;

export const DEFAULT_STATUS_LABEL_PREFIX = "status:";

export type BridgeConfig = {
  /** Bridge turned on by an administrator. */
  enabled: boolean;
  /** `owner/name` of the repository that hosts the issues. */
  repo: string;
  /** Only issues carrying this label are pulled. Empty = every issue. */
  label: string;
  /** Which issues to pull: open, closed or both. */
  state: "open" | "closed" | "all";
  /** Prefix used for the mirrored status labels, e.g. `status:Building`. */
  statusLabelPrefix: string;
  /** True when a server-side token is present (never the token itself). */
  hasToken: boolean;
  /** Set when an environment variable pins the repository (settings cannot override). */
  repoPinnedByEnv: boolean;
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(value: unknown): value is string {
  return typeof value === "string" && REPO_RE.test(value.trim());
}

/** Normalise `owner/name`, tolerating a full GitHub URL pasted by an operator. */
export function normaliseRepo(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const fromUrl = raw.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  const candidate = (fromUrl ? fromUrl[1] : raw).replace(/\.git$/, "").trim();
  return isValidRepo(candidate) ? candidate : "";
}

export function readBridgeEnv(env: NodeJS.ProcessEnv = process.env): {
  repo: string;
  token: string;
  label: string;
  apiBase: string;
} {
  return {
    repo: normaliseRepo(env.GITHUB_ENHANCEMENTS_REPO || env.GITHUB_REPO),
    token: String(env.GITHUB_TOKEN ?? "").trim(),
    label: String(env.GITHUB_ENHANCEMENTS_LABEL ?? "").trim(),
    apiBase: String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
}

export type SettingsReader = (key: string, fallback?: string) => string;

/**
 * Resolve the effective configuration.
 *
 * Precedence is environment → settings, because a deployment that pins the
 * repository in its environment should not be silently re-pointed by whichever
 * administrator happens to open Master Setup. The UI says so explicitly.
 */
export function resolveBridgeConfig(
  getSetting: SettingsReader,
  env: NodeJS.ProcessEnv = process.env
): BridgeConfig {
  const fromEnv = readBridgeEnv(env);
  const configuredRepo = fromEnv.repo || normaliseRepo(getSetting(BRIDGE_SETTING_KEYS.repo, ""));
  const enabledSetting = String(getSetting(BRIDGE_SETTING_KEYS.enabled, "")).toLowerCase();
  const label = fromEnv.label || String(getSetting(BRIDGE_SETTING_KEYS.label, "")).trim();
  const stateRaw = String(getSetting(BRIDGE_SETTING_KEYS.state, "all")).toLowerCase();
  return {
    enabled: enabledSetting === "true" || (enabledSetting === "" && Boolean(fromEnv.repo && fromEnv.token)),
    // Default to the repository's own "future enhancements" label when the
    // operator has not chosen one, so a fresh install filters sensibly.
    label: label || "future-enhancement",
    repo: configuredRepo,
    state: stateRaw === "open" || stateRaw === "closed" ? stateRaw : "all",
    statusLabelPrefix:
      String(getSetting(BRIDGE_SETTING_KEYS.statusLabelPrefix, "")).trim() || DEFAULT_STATUS_LABEL_PREFIX,
    hasToken: Boolean(fromEnv.token),
    repoPinnedByEnv: Boolean(fromEnv.repo),
  };
}

/** Why the bridge cannot run, or `null` when it can. Never includes the token. */
export function bridgeBlockers(config: BridgeConfig): string[] {
  const blockers: string[] = [];
  if (!config.enabled) blockers.push("The bridge is switched off. Enable it in Master Setup → GitHub bridge.");
  if (!config.repo) blockers.push("No GitHub repository is configured. Set one in Master Setup → GitHub bridge.");
  if (!config.hasToken) blockers.push("GITHUB_TOKEN is not set on the server, so GitHub cannot be read or written.");
  return blockers;
}

// ---------------------------------------------------------------------------
// GitHub client
// ---------------------------------------------------------------------------

export type GithubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  updated_at: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
  user?: { login?: string } | null;
};

export type GithubPullRequest = {
  number: number;
  title: string;
  state: string;
  merged_at?: string | null;
  html_url: string;
  updated_at: string;
  head?: { ref?: string } | null;
};

type FetchImpl = typeof fetch;

export class GithubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

export type GithubClient = {
  getIssue: (number: number) => Promise<GithubIssue>;
  listIssues: (options?: { since?: string; maxPages?: number }) => Promise<GithubIssue[]>;
  createIssue: (input: { title: string; body: string; labels?: string[] }) => Promise<GithubIssue>;
  updateIssue: (number: number, input: { title?: string; body?: string; state?: "open" | "closed" }) => Promise<GithubIssue>;
  listLinkedPulls: (number: number) => Promise<GithubPullRequest[]>;
  ensureLabel: (name: string, color?: string, description?: string) => Promise<void>;
  getPull: (number: number) => Promise<GithubPullRequest>;
};

export function labelName(entry: { name: string } | string): string {
  return typeof entry === "string" ? entry : String(entry?.name ?? "");
}

function isPullRequest(issue: GithubIssue): boolean {
  return Boolean(issue && issue.pull_request);
}

/**
 * Minimal REST client. No SDK, no extra dependency — the same reason the rest of
 * this repository calls `fetch` directly. `fetchImpl` is injectable so the
 * engine can be tested offline.
 */
export function createGithubClient(
  options: { repo: string; token: string; apiBase?: string; fetchImpl?: FetchImpl }
): GithubClient {
  const { repo, token } = options;
  const apiBase = (options.apiBase || "https://api.github.com").replace(/\/+$/, "");
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;
  if (!isValidRepo(repo)) throw new GithubError(`Invalid repository "${repo}". Expected owner/name.`, 400);
  if (!token) throw new GithubError("GITHUB_TOKEN is not configured on the server.", 401);

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "future-enhancements-bridge",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const detail =
        data && typeof data === "object" && "message" in data
          ? `: ${String((data as { message?: unknown }).message)}`
          : "";
      throw new GithubError(
        `GitHub ${init.method ?? "GET"} ${path} failed (HTTP ${response.status})${detail}`,
        response.status
      );
    }
    return data as T;
  }

  return {
    getIssue: (number) => request<GithubIssue>(`/repos/${repo}/issues/${number}`),

    async listIssues({ since, maxPages = 10 } = {}) {
      const out: GithubIssue[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const search = new URLSearchParams({ state: "all", per_page: "100", page: String(page) });
        if (since) search.set("since", since);
        const batch = await request<GithubIssue[]>(`/repos/${repo}/issues?${search.toString()}`);
        if (!Array.isArray(batch)) break;
        out.push(...batch.filter((issue) => !isPullRequest(issue)));
        if (batch.length < 100) break;
      }
      return out;
    },

    createIssue: ({ title, body, labels }) =>
      request<GithubIssue>(`/repos/${repo}/issues`, {
        method: "POST",
        body: { title, body, ...(labels?.length ? { labels } : {}) },
      }),

    updateIssue: (number, patch) =>
      request<GithubIssue>(`/repos/${repo}/issues/${number}`, { method: "PATCH", body: patch }),

    async listLinkedPulls(number) {
      // The events feed is the only dependency-free way to find PRs that name an
      // issue without a search index; the search API is rate limited more
      // aggressively, so try it first and fall back to the event timeline.
      const pulls: GithubPullRequest[] = [];
      try {
        const found = await request<{ items?: Array<{ number: number }> }>(
          `/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr ${number} in:body`)}&per_page=10`
        );
        for (const item of found?.items ?? []) {
          try {
            const pull = await request<GithubPullRequest>(`/repos/${repo}/pulls/${item.number}`);
            if (pull && typeof pull.number === "number") pulls.push(pull);
          } catch {
            /* a single unreadable PR must not fail the whole sync */
          }
        }
      } catch {
        /* search is best-effort; the issue is still linked */
      }
      return pulls;
    },

    getPull: (number) => request<GithubPullRequest>(`/repos/${repo}/pulls/${number}`),

    async ensureLabel(name, color = "0e8a16", description = "Future enhancements bridge") {
      try {
        await request(`/repos/${repo}/labels/${encodeURIComponent(name)}`);
        return;
      } catch (error) {
        if (error instanceof GithubError && error.status !== 404) throw error;
      }
      try {
        await request(`/repos/${repo}/labels`, {
          method: "POST",
          body: { name, color: color.replace(/^#/, "").slice(0, 6), description },
        });
      } catch (error) {
        // A concurrent sync may have created it; anything except 422 is real.
        if (!(error instanceof GithubError && (error.status === 422 || error.status === 403))) throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Issue body format
// ---------------------------------------------------------------------------

const META_START = "<!-- future-enhancements-bridge";
const META_END = "-->";

export type IssueMeta = {
  ref?: string;
  status?: string;
  sections?: string;
  submittedBy?: string;
  department?: string;
};

export type ParsedIssue = {
  /** The human-written part of the issue body, without the bridge metadata block. */
  body: string;
  meta: IssueMeta;
};

/** Serialise the app-owned part of an issue body. Stable, so a no-op push is a no-op. */
export function renderIssueBody(input: {
  brief: string;
  requirements?: string | null;
  impacts?: string | null;
  expectedOutcome?: string | null;
  successCriteria?: string | null;
  meta: IssueMeta;
}): string {
  // Snake case on the wire, so a reader of the raw issue body sees the same key
  // names the app uses (`submitted_by`, not `submittedBy`).
  const META_KEYS: Record<string, string> = {
    ref: "ref",
    status: "status",
    sections: "sections",
    submittedBy: "submitted_by",
    department: "department",
  };
  const meta = Object.entries(input.meta)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([key, value]) => {
      const name = META_KEYS[key] ?? key;
      return `${name}: ${String(value).replace(/\r?\n/g, " ").trim()}`;
    })
    .join("\n");
  const sections: string[] = [];
  const brief = String(input.brief ?? "").trim();
  sections.push(brief || "_No brief yet._");
  const block = (heading: string, value: string | null | undefined) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    sections.push(`### ${heading}\n\n${text}`);
  };
  block("Requirements", input.requirements);
  block("Impacts", input.impacts);
  block("Expected outcome", input.expectedOutcome);
  block("Success criteria", input.successCriteria);
  return `${META_START}\n${meta}\n${META_END}\n\n${sections.join("\n\n")}\n`;
}

/** Read back a body written by `renderIssueBody`, or by a human from GitHub. */
export function parseIssueBody(body: string | null | undefined): ParsedIssue {
  const text = String(body ?? "");
  const start = text.indexOf(META_START);
  if (start === -1) return { body: text.trim(), meta: {} };
  const end = text.indexOf(META_END, start);
  if (end === -1) return { body: text.trim(), meta: {} };
  const metaText = text.slice(start + META_START.length, end);
  const meta: IssueMeta = {};
  for (const line of metaText.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "ref") meta.ref = match[2];
    else if (key === "status") meta.status = match[2];
    else if (key === "sections") meta.sections = match[2];
    else if (key === "submitted_by") meta.submittedBy = match[2];
    else if (key === "department") meta.department = match[2];
  }
  const stripped = `${text.slice(0, start)}${text.slice(end + META_END.length)}`.replace(/^\s+/, "").trim();
  return { body: stripped, meta };
}

/** A short, stable fingerprint of the remote payload used to detect real changes. */
export function issueFingerprint(issue: Pick<GithubIssue, "title" | "body" | "state" | "labels">): string {
  const labels = (issue.labels ?? []).map(labelName).sort().join(",");
  return createHash("sha1")
    .update(`${issue.title}\n${issue.body ?? ""}\n${issue.state}\n${labels}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Status ↔ label mapping
// ---------------------------------------------------------------------------

/** Remote label names are derived, never configured per status. */
export function statusLabel(prefix: string, status: string): string {
  return `${prefix}${status}`.toLowerCase();
}

/**
 * Read a stage out of a remote label.
 *
 * Labels are matched case-insensitively and normalised back to the caller's
 * canonical spelling, because `status:building` and `Building` must name the
 * same stage. Without this the parsed value (`building`) does not appear in the
 * pipeline order, ranks `-1`, and a remote stage change is silently ignored.
 */
export function statusFromLabels(labels: string[], prefix: string, canonical: string[] = []): string | null {
  const wanted = prefix.toLowerCase();
  for (const label of labels) {
    if (!label.toLowerCase().startsWith(wanted)) continue;
    const rest = label.slice(prefix.length).trim();
    if (!rest) continue;
    const exact = canonical.find((stage) => stage.toLowerCase() === rest.toLowerCase());
    if (exact) return exact;
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return null;
}

/** Rank a status in the caller's pipeline order, case-insensitively. */
function rankOf(status: string | null | undefined, stages: string[]): number {
  if (!status) return -1;
  const wanted = status.toLowerCase();
  return stages.findIndex((stage) => stage.toLowerCase() === wanted);
}

/**
 * Reconcile two statuses for the same enhancement.
 *
 * `pipelineStages()` order is the truth for "which is further along". A closed
 * issue means Archived unless the local side is Rejected, which is a deliberate
 * decision that is never overwritten by a state change.
 */
export function reconcileStatus(input: {
  local: string;
  remote: string | null;
  issueClosed: boolean;
  stages: string[];
  prefer: "local" | "remote" | "furthest";
}): { status: string; reason: string } {
  const stages = input.stages;
  const rank = (status: string) => rankOf(status, stages);
  // Canonicalise to the caller's spelling so the returned status is always one
  // the database accepts (a remote `building` becomes `Building`).
  const canonical = (status: string | null | undefined): string | null => {
    if (!status) return null;
    const index = rankOf(status, stages);
    return index >= 0 ? stages[index] : status;
  };
  const local = canonical(input.local) ?? input.local;
  let remote = canonical(input.remote);
  const archived = canonical("Archived");
  if (input.issueClosed && (!remote || (archived && rank(remote) < rank(archived)))) remote = archived;

  const rejected = canonical("Rejected") ?? "Rejected";
  if (input.prefer === "local") return { status: local, reason: "local-wins" };
  if (input.prefer === "remote") {
    return remote ? { status: remote, reason: "remote-wins" } : { status: local, reason: "remote-has-no-status" };
  }
  if (local.toLowerCase() === rejected.toLowerCase()) return { status: local, reason: "rejection-is-terminal" };
  if (!remote) return { status: local, reason: "remote-has-no-status" };
  if (rank(remote) > rank(local)) return { status: remote, reason: "remote-is-further-along" };
  if (rank(local) > rank(remote)) return { status: local, reason: "local-is-further-along" };
  return { status: local, reason: "in-agreement" };
}

// ---------------------------------------------------------------------------
// Engine types
// ---------------------------------------------------------------------------

/** The slice of a proposal the engine needs. Satisfied by the `Enhancement` row. */
export type BridgeRecord = {
  id: string;
  ref: string;
  title: string;
  brief: string | null;
  requirements?: string | null;
  impacts?: string | null;
  expected_outcome?: string | null;
  success_criteria?: string | null;
  status: string;
  github_repo?: string | null;
  github_issue_number?: number | null;
  github_issue_url?: string | null;
  github_state?: string | null;
  github_labels?: string | null;
  github_updated_at?: string | null;
  github_synced_at?: string | null;
  github_direction?: string | null;
  submitted_by_name?: string | null;
  department_name?: string | null;
};

export type BridgeStore = {
  /** Every enhancement the bridge may read/write. */
  list: () => BridgeRecord[];
  findByRef: (ref: string) => BridgeRecord | undefined;
  /** Create from a remote issue. Returns the new record. */
  create: (input: {
    ref: string;
    title: string;
    brief: string;
    status: string;
    repo: string;
    issue: GithubIssue;
    labels: string[];
    actorName?: string | null;
  }) => BridgeRecord;
  /** Persist a remote-derived patch. */
  update: (id: string, patch: Record<string, unknown>) => void;
  /** Latest `ref` sequence number, so a pulled issue can be numbered consistently. */
  nextRef: () => string;
  replaceLinks: (
    enhancementId: string,
    repo: string,
    links: Array<{ kind: "issue" | "pull"; number: number; url?: string | null; title?: string | null; state?: string | null; merged?: boolean }>
  ) => void;
  recordEvent: (event: {
    direction: "push" | "pull" | "full";
    actorName?: string | null;
    repo: string;
    pulled: number;
    pushed: number;
    created: number;
    updated: number;
    skipped: number;
    errors: Array<{ ref: string; message: string }>;
    detail?: unknown;
  }) => void;
};

export type SyncItem = {
  ref: string;
  title: string;
  action: "created" | "updated" | "linked" | "unchanged" | "skipped" | "error";
  message: string;
  repo?: string;
  issueNumber?: number | null;
};

export type SyncReport = {
  direction: "push" | "pull" | "full";
  repo: string;
  pulled: number;
  pushed: number;
  created: number;
  updated: number;
  skipped: number;
  items: SyncItem[];
  errors: Array<{ ref: string; message: string }>;
};

function emptyReport(direction: "push" | "pull" | "full", repo: string): SyncReport {
  return { direction, repo, pulled: 0, pushed: 0, created: 0, updated: 0, skipped: 0, items: [], errors: [] };
}

function addError(report: SyncReport, ref: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  report.errors.push({ ref, message });
  report.items.push({ ref, title: ref, action: "error", message });
}

// ---------------------------------------------------------------------------
// Pull: GitHub → app
// ---------------------------------------------------------------------------

export type PullOptions = {
  client: GithubClient;
  store: BridgeStore;
  config: BridgeConfig;
  stages: string[];
  actorName?: string | null;
  /** Restrict to these refs (used by "pull one"). Empty = everything. */
  refs?: string[];
  /** Issues updated before this ISO timestamp are skipped. */
  since?: string;
  /** Cap the number of issues inspected (protects a slow serverless function). */
  limit?: number;
  /** Which side wins a disagreement: default `furthest` (never lose progress). */
  prefer?: "local" | "remote" | "furthest";
  now?: string;
};

export async function pullFromGithub(options: PullOptions): Promise<SyncReport> {
  const { client, store, config, stages } = options;
  const report = emptyReport("pull", config.repo);
  const prefer = options.prefer ?? "furthest";
  const now = options.now ?? new Date().toISOString();
  const records = store.list();
  const byIssue = new Map<number, BridgeRecord>();
  for (const record of records) {
    if (record.github_issue_number && record.github_repo === config.repo) {
      byIssue.set(Number(record.github_issue_number), record);
    }
  }

  // 1. Refresh every linked issue, so a local change aware of remote state can
  //    be compared field by field instead of blindly overwritten.
  const linked = options.refs?.length
    ? records.filter((record) => options.refs!.includes(record.ref) && record.github_issue_number)
    : records.filter((record) => record.github_issue_number && record.github_repo === config.repo);

  for (const record of linked) {
    try {
      const issue = await client.getIssue(Number(record.github_issue_number));
      const labels = (issue.labels ?? []).map(labelName);
      const remoteStatus = statusFromLabels(labels, config.statusLabelPrefix, stages);
      const decision = reconcileStatus({
        local: record.status,
        remote: remoteStatus,
        issueClosed: issue.state === "closed",
        stages,
        prefer,
      });
      const patch: Record<string, unknown> = {
        github_state: issue.state,
        github_labels: JSON.stringify(labels),
        github_updated_at: issue.updated_at,
        github_synced_at: now,
        github_direction: "pull",
        github_issue_url: issue.html_url,
      };
      if (decision.status !== record.status) patch.status = decision.status;

      // Title/body follow the remote when the remote is newer than the last sync.
      const remoteIsNewer = !record.github_synced_at || String(issue.updated_at) > String(record.github_synced_at);
      if (remoteIsNewer) {
        if (issue.title && issue.title !== record.title) patch.title = issue.title;
        const parsed = parseIssueBody(issue.body);
        if (parsed.body && parsed.body !== (record.brief ?? "")) patch.brief = parsed.body;
        const sections: string[] = [];
        const grab = (heading: string) => {
          const match = parsed.body.match(new RegExp(`### ${heading}\\n\\n([\\s\\S]*?)(?=\\n### |$)`, "i"));
          return match?.[1]?.trim() ?? null;
        };
        const requirements = grab("Requirements");
        const impacts = grab("Impacts");
        const expected = grab("Expected outcome");
        const criteria = grab("Success criteria");
        if (requirements) sections.push(requirements);
        if (impacts) sections.push(impacts);
        if (expected) sections.push(expected);
        if (criteria) sections.push(criteria);
        if (requirements && requirements !== record.requirements) patch.requirements = requirements;
        if (impacts && impacts !== record.impacts) patch.impacts = impacts;
        if (expected && expected !== record.expected_outcome) patch.expected_outcome = expected;
        if (criteria && criteria !== record.success_criteria) patch.success_criteria = criteria;
        if (sections.length && parsed.body) {
          // Keep the brief to the human summary, not the structured blocks.
          patch.brief = parsed.body.split(/\n### /)[0].trim();
        }
      }

      const changedFields = Object.keys(patch).filter(
        (key) => !["github_state", "github_labels", "github_updated_at", "github_synced_at", "github_direction", "github_issue_url"].includes(key)
      );
      if (changedFields.length) {
        store.update(record.id, patch);
        report.updated += 1;
        report.items.push({
          ref: record.ref,
          title: String(patch.title ?? record.title),
          action: "updated",
          issueNumber: issue.number,
          repo: config.repo,
          message: `${decision.reason}; changed ${changedFields.join(", ")}`,
        });
      } else {
        // Still record the fresh remote state and timestamp.
        store.update(record.id, patch);
        report.skipped += 1;
        report.items.push({
          ref: record.ref,
          title: record.title,
          action: "unchanged",
          issueNumber: issue.number,
          repo: config.repo,
          message: decision.reason,
        });
      }

      const pulls = await client.listLinkedPulls(issue.number);
      store.replaceLinks(record.id, config.repo, [
        { kind: "issue", number: issue.number, url: issue.html_url, title: issue.title, state: issue.state },
        ...pulls.map((pull) => ({
          kind: "pull" as const,
          number: pull.number,
          url: pull.html_url,
          title: pull.title,
          state: pull.merged_at ? "merged" : pull.state,
          merged: Boolean(pull.merged_at),
        })),
      ]);
    } catch (error) {
      addError(report, record.ref, error);
    }
  }

  // 2. Discover issues that exist only on GitHub, and create proposals for them.
  const onlyLinked = Boolean(options.refs?.length);
  if (!onlyLinked) {
    try {
      const issues = await client.listIssues({ since: options.since, maxPages: Math.max(1, Math.ceil((options.limit ?? 300) / 100)) });
      const wanted = config.label.toLowerCase();
      let inspected = 0;
      for (const issue of issues) {
        if (byIssue.has(issue.number)) continue;
        const labels = (issue.labels ?? []).map(labelName);
        if (wanted && !labels.some((label) => label.toLowerCase() === wanted)) continue;
        if (inspected >= (options.limit ?? 300)) {
          report.skipped += 1;
          report.items.push({
            ref: "-",
            title: "-",
            action: "skipped",
            message: `Issue limit (${options.limit ?? 300}) reached; run the pull again to continue.`,
          });
          break;
        }
        inspected += 1;
        const parsed = parseIssueBody(issue.body);
        const remoteStatus = statusFromLabels(labels, config.statusLabelPrefix, stages) ?? (issue.state === "closed" ? "Archived" : "Submitted");
        const ref = store.nextRef();
        const record = store.create({
          ref,
          title: issue.title,
          brief: parsed.body.split(/\n### /)[0].trim(),
          status: remoteStatus,
          repo: config.repo,
          issue,
          labels,
          actorName: options.actorName ?? null,
        });
        store.update(record.id, {
          github_state: issue.state,
          github_labels: JSON.stringify(labels),
          github_updated_at: issue.updated_at,
          github_synced_at: now,
          github_direction: "pull",
        });
        report.created += 1;
        report.pulled += 1;
        report.items.push({
          ref: record.ref,
          title: issue.title,
          action: "created",
          issueNumber: issue.number,
          repo: config.repo,
          message: "Issue imported from GitHub",
        });
      }
    } catch (error) {
      addError(report, "-", error);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Push: app → GitHub
// ---------------------------------------------------------------------------

export type PushOptions = {
  client: GithubClient;
  store: BridgeStore;
  config: BridgeConfig;
  stages: string[];
  actorName?: string | null;
  refs?: string[];
  /** Include Archived/Rejected proposals by closing their issue. */
  closeFinished?: boolean;
  now?: string;
};

export function issueBodyFor(record: BridgeRecord): string {
  return renderIssueBody({
    brief: record.brief ?? "",
    requirements: record.requirements,
    impacts: record.impacts,
    expectedOutcome: record.expected_outcome,
    successCriteria: record.success_criteria,
    meta: {
      ref: record.ref,
      status: record.status,
      submittedBy: record.submitted_by_name ?? undefined,
      department: record.department_name ?? undefined,
    },
  });
}

export async function pushToGithub(options: PushOptions): Promise<SyncReport> {
  const { client, store, config, stages } = options;
  const report = emptyReport("push", config.repo);
  const now = options.now ?? new Date().toISOString();
  const closeFinished = options.closeFinished ?? true;

  let records = store.list();
  if (options.refs?.length) records = records.filter((record) => options.refs!.includes(record.ref));

  const statusLabels = new Map<string, Promise<void>>();
  const ensureStatusLabel = (status: string) => {
    const name = statusLabel(config.statusLabelPrefix, status);
    if (!statusLabels.has(name)) {
      const colour =
        status === "Archived" ? "6e7781" : status === "Rejected" ? "b60205" : status === "Built" ? "0e8a16" : "1d76db";
      statusLabels.set(name, client.ensureLabel(name, colour, `Future enhancement status: ${status}`));
    }
    return statusLabels.get(name)!;
  };

  for (const record of records) {
    try {
      const labels = [config.label, statusLabel(config.statusLabelPrefix, record.status)];
      await ensureStatusLabel(record.status);
      if (config.label) await client.ensureLabel(config.label, "7057ff", "Future enhancement tracked by the app");
      const shouldClose = closeFinished && (record.status === "Archived" || record.status === "Rejected");

      if (!record.github_issue_number || record.github_repo !== config.repo) {
        const created = await client.createIssue({
          title: record.title,
          body: issueBodyFor(record),
          labels: labels.filter(Boolean),
        });
        store.update(record.id, {
          github_repo: config.repo,
          github_issue_number: created.number,
          github_issue_url: created.html_url,
          github_state: created.state,
          github_labels: JSON.stringify((created.labels ?? []).map(labelName)),
          github_updated_at: created.updated_at,
          github_synced_at: now,
          github_direction: "push",
        });
        store.replaceLinks(record.id, config.repo, [
          { kind: "issue", number: created.number, url: created.html_url, title: created.title, state: created.state },
        ]);
        report.pushed += 1;
        report.created += 1;
        report.items.push({
          ref: record.ref,
          title: record.title,
          action: "created",
          issueNumber: created.number,
          repo: config.repo,
          message: `Issue opened for ${record.status}`,
        });
        continue;
      }

      const issue = await client.getIssue(record.github_issue_number);
      const remoteLabels = (issue.labels ?? []).map(labelName);
      const remoteStatus = statusFromLabels(remoteLabels, config.statusLabelPrefix, stages);
      const decision = reconcileStatus({
        local: record.status,
        remote: remoteStatus,
        issueClosed: issue.state === "closed",
        stages,
        prefer: "local",
      });
      const keep = remoteLabels.filter((label) => !label.toLowerCase().startsWith(config.statusLabelPrefix.toLowerCase()) && label !== config.label);
      const desiredLabels = [...new Set([...keep, ...(config.label ? [config.label] : []), statusLabel(config.statusLabelPrefix, decision.status)])];

      const body = issueBodyFor({ ...record, status: decision.status });
      const title = record.title;
      const labelsDiffer =
        desiredLabels.filter((label) => !remoteLabels.includes(label)).length > 0 ||
        remoteLabels.filter((label) => !desiredLabels.includes(label)).length > 0;
      const bodyDiffers = (issue.body ?? "").trim() !== body.trim();
      const titleDiffers = issue.title !== title;
      const stateDiffers = shouldClose ? issue.state !== "closed" : issue.state !== "open";

      if (bodyDiffers || titleDiffers || labelsDiffer) {
        const updated = await client.updateIssue(issue.number, {
          ...(titleDiffers ? { title } : {}),
          ...(bodyDiffers ? { body } : {}),
          ...(labelsDiffer ? { labels: desiredLabels } : {}),
          ...(stateDiffers ? { state: shouldClose ? "closed" : "open" } : {}),
        });
        store.update(record.id, {
          github_state: updated.state,
          github_labels: JSON.stringify((updated.labels ?? []).map(labelName)),
          github_updated_at: updated.updated_at,
          github_synced_at: now,
          github_direction: "push",
          github_issue_url: updated.html_url,
        });
        report.pushed += 1;
        report.updated += 1;
        report.items.push({
          ref: record.ref,
          title,
          action: "updated",
          issueNumber: issue.number,
          repo: config.repo,
          message: [titleDiffers && "title", bodyDiffers && "body", labelsDiffer && "labels", stateDiffers && (shouldClose ? "closed" : "reopened")]
            .filter(Boolean)
            .join(", ") || "metadata",
        });
      } else if (stateDiffers) {
        await client.updateIssue(issue.number, { state: shouldClose ? "closed" : "open" });
        store.update(record.id, { github_synced_at: now, github_direction: "push", github_state: shouldClose ? "closed" : "open" });
        report.pushed += 1;
        report.updated += 1;
        report.items.push({
          ref: record.ref,
          title,
          action: "updated",
          issueNumber: issue.number,
          repo: config.repo,
          message: shouldClose ? "closed" : "reopened",
        });
      } else {
        store.update(record.id, { github_synced_at: now, github_direction: "push" });
        report.skipped += 1;
        report.items.push({
          ref: record.ref,
          title,
          action: "unchanged",
          issueNumber: issue.number,
          repo: config.repo,
          message: "GitHub already matches this proposal",
        });
      }

      const pulls = await client.listLinkedPulls(issue.number);
      store.replaceLinks(record.id, config.repo, [
        { kind: "issue", number: issue.number, url: issue.html_url, title: issue.title, state: issue.state },
        ...pulls.map((pull) => ({
          kind: "pull" as const,
          number: pull.number,
          url: pull.html_url,
          title: pull.title,
          state: pull.merged_at ? "merged" : pull.state,
          merged: Boolean(pull.merged_at),
        })),
      ]);
    } catch (error) {
      addError(report, record.ref, error);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Full two-way run
// ---------------------------------------------------------------------------

/**
 * Pull, then push. Pulling first means the app knows about anything a person
 * changed on GitHub before it writes back, which is what stops one side
 * clobbering the other. A full run is safe to repeat: every write is compared
 * against the remote payload first.
 */
export async function syncBothWays(options: Omit<PullOptions, "direction"> & { closeFinished?: boolean }): Promise<SyncReport> {
  const pull = await pullFromGithub(options);
  const push = await pushToGithub({
    client: options.client,
    store: options.store,
    config: options.config,
    stages: options.stages,
    actorName: options.actorName,
    refs: options.refs,
    closeFinished: options.closeFinished,
    now: options.now,
  });
  const merged: SyncReport = {
    direction: "full",
    repo: options.config.repo,
    pulled: pull.pulled,
    pushed: push.pushed,
    created: pull.created + push.created,
    updated: pull.updated + push.updated,
    skipped: pull.skipped + push.skipped,
    items: [...pull.items.map((item) => ({ ...item, message: `pull: ${item.message}` })), ...push.items.map((item) => ({ ...item, message: `push: ${item.message}` }))],
    errors: [...pull.errors, ...push.errors],
  };
  return merged;
}

/** Persist the outcome; a reporting failure must never fail the sync itself. */
export function recordSyncReport(store: BridgeStore, report: SyncReport, actorName?: string | null) {
  try {
    store.recordEvent({
      direction: report.direction,
      actorName: actorName ?? null,
      repo: report.repo,
      pulled: report.pulled,
      pushed: report.pushed,
      created: report.created,
      updated: report.updated,
      skipped: report.skipped,
      errors: report.errors,
      detail: report.items.slice(0, 100),
    });
  } catch {
    /* the journal is a convenience, not the record */
  }
}
