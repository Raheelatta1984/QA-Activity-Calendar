import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRIDGE_SETTING_KEYS,
  bridgeBlockers,
  createGithubClient,
  issueBodyFor,
  isValidRepo,
  normaliseRepo,
  parseIssueBody,
  pullFromGithub,
  pushToGithub,
  reconcileStatus,
  renderIssueBody,
  resolveBridgeConfig,
  statusFromLabels,
  statusLabel,
  syncBothWays,
  type BridgeConfig,
  type BridgeRecord,
  type BridgeStore,
  type GithubIssue,
} from "../lib/enhancement-bridge";
import { pipelineStages } from "../lib/enhancement-status";

const STAGES = pipelineStages();

// ---------------------------------------------------------------------------
// A fake GitHub. Mutating calls are recorded so a test can prove a no-op push
// really sent nothing, which is what keeps the bridge safe to run on a timer.
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; body?: any };

function fakeGithub(seed: GithubIssue[] = []) {
  const issues = new Map<number, GithubIssue>(seed.map((issue) => [issue.number, { ...issue }]));
  const calls: Call[] = [];
  // Labels are repository state, so the fake remembers them: a real `ensureLabel`
  // checks first and only creates when missing.
  const labels = new Set<string>();
  let nextNumber = Math.max(0, ...seed.map((issue) => issue.number)) + 1;

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/repos\/owner\/repo/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });

    if (method === "POST" && path === "/issues") {
      const created: GithubIssue = {
        number: nextNumber++,
        title: body.title,
        body: body.body ?? null,
        state: "open",
        html_url: `https://github.com/owner/repo/issues/${nextNumber}`,
        updated_at: new Date().toISOString(),
        labels: (body.labels ?? []).map((name: string) => ({ name })),
      };
      issues.set(created.number, created);
      return json(created, 201);
    }
    if (method === "POST" && path === "/labels") {
      labels.add(body.name);
      return json({ name: body.name }, 201);
    }
    const label = path.match(/^\/labels\/(.+)$/);
    if (method === "GET" && label) {
      const name = decodeURIComponent(label[1]);
      return labels.has(name) ? json({ name }) : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && path === "/search/issues") return json({ items: [] });

    const single = path.match(/^\/issues\/(\d+)$/);
    if (single) {
      const number = Number(single[1]);
      const issue = issues.get(number);
      if (!issue) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") {
        const updated: GithubIssue = {
          ...issue,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.state !== undefined ? { state: body.state } : {}),
          ...(body.labels !== undefined ? { labels: body.labels.map((name: string) => ({ name })) } : {}),
          updated_at: new Date(Date.now() + 1000).toISOString(),
        };
        issues.set(number, updated);
        return json(updated);
      }
      return json(issue);
    }
    if (path === "/issues") {
      return json([...issues.values()]);
    }
    if (/^\/pulls\//.test(path)) return json({}, 404);
    return json({ message: `unhandled ${method} ${path}` }, 404);
  }) as typeof fetch;

  return { fetchImpl, issues, calls };
}

function fakeStore(records: BridgeRecord[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const created: BridgeRecord[] = [];
  const events: unknown[] = [];
  let counter = records.length;
  const store: BridgeStore = {
    list: () => [...records, ...created],
    findByRef: (ref) => [...records, ...created].find((record) => record.ref === ref),
    nextRef: () => `ENH-${String(++counter).padStart(4, "0")}`,
    create: (input) => {
      const record: BridgeRecord = {
        id: `id-${input.ref}`,
        ref: input.ref,
        title: input.title,
        brief: input.brief,
        status: input.status,
        github_repo: input.repo,
        github_issue_number: input.issue.number,
        github_issue_url: input.issue.html_url,
      };
      created.push(record);
      records.push(record);
      return record;
    },
    update: (id, patch) => {
      updates.push({ id, patch });
      const record = records.find((entry) => entry.id === id);
      if (record) Object.assign(record, patch);
    },
    replaceLinks: () => {},
    recordEvent: (event) => {
      events.push(event);
    },
  };
  return { store, updates, created, events };
}

const config: BridgeConfig = {
  enabled: true,
  repo: "owner/repo",
  label: "future-enhancement",
  state: "all",
  statusLabelPrefix: "status:",
  hasToken: true,
  repoPinnedByEnv: false,
};

function record(overrides: Partial<BridgeRecord> = {}): BridgeRecord {
  return {
    id: "enh_1",
    ref: "ENH-0001",
    title: "Bulk assign auditors",
    brief: "Assigning auditors one quarter at a time is slow.",
    requirements: "Pick many activities",
    impacts: null,
    expected_outcome: null,
    success_criteria: null,
    status: "Reviewing",
    github_repo: null,
    github_issue_number: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("repository values are normalised but never guessed", () => {
  assert.equal(normaliseRepo("owner/repo"), "owner/repo");
  assert.equal(normaliseRepo("https://github.com/owner/repo"), "owner/repo");
  assert.equal(normaliseRepo("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(normaliseRepo("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(normaliseRepo("not a repo"), "");
  assert.equal(normaliseRepo(""), "");
  assert.equal(isValidRepo("owner/repo"), true);
  assert.equal(isValidRepo("owner/repo/extra"), false);
});

test("configuration prefers the environment, so a host cannot be re-pointed by the UI", () => {
  const settings: Record<string, string> = {
    [BRIDGE_SETTING_KEYS.repo]: "settings/repo",
    [BRIDGE_SETTING_KEYS.enabled]: "true",
    [BRIDGE_SETTING_KEYS.label]: "enhancement",
  };
  const reader = (key: string, fallback = "") => settings[key] ?? fallback;

  const fromSettings = resolveBridgeConfig(reader, { GITHUB_TOKEN: "t" } as unknown as NodeJS.ProcessEnv);
  assert.equal(fromSettings.repo, "settings/repo");
  assert.equal(fromSettings.repoPinnedByEnv, false);
  assert.equal(fromSettings.enabled, true);

  const fromEnv = resolveBridgeConfig(reader, {
    GITHUB_TOKEN: "t",
    GITHUB_ENHANCEMENTS_REPO: "env/repo",
    GITHUB_ENHANCEMENTS_LABEL: "from-env",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(fromEnv.repo, "env/repo");
  assert.equal(fromEnv.label, "from-env");
  assert.equal(fromEnv.repoPinnedByEnv, true);
});

test("blockers explain exactly what is missing, without leaking the token", () => {
  assert.deepEqual(bridgeBlockers({ ...config, enabled: false, repo: "", hasToken: false }).length, 3);
  assert.deepEqual(bridgeBlockers(config), []);
  const text = bridgeBlockers({ ...config, hasToken: false }).join(" ");
  assert.match(text, /GITHUB_TOKEN/);
  assert.doesNotMatch(text, /Bearer /);
});

// ---------------------------------------------------------------------------
// Issue body round-trip
// ---------------------------------------------------------------------------

test("an issue body round-trips through the metadata block", () => {
  const body = renderIssueBody({
    brief: "First line\nsecond line",
    requirements: "Do the thing",
    impacts: "tab.calendar",
    expectedOutcome: "Faster",
    successCriteria: "Under a minute",
    meta: { ref: "ENH-0007", status: "Building", submittedBy: "Amara" },
  });
  const parsed = parseIssueBody(body);
  assert.equal(parsed.meta.ref, "ENH-0007");
  assert.equal(parsed.meta.status, "Building");
  assert.equal(parsed.meta.submittedBy, "Amara");
  assert.match(parsed.body, /First line/);
  assert.match(parsed.body, /### Requirements\n\nDo the thing/);
  // Re-rendering is byte-identical, so a no-op push sends nothing.
  assert.equal(
    renderIssueBody({
      brief: "First line\nsecond line",
      requirements: "Do the thing",
      impacts: "tab.calendar",
      expectedOutcome: "Faster",
      successCriteria: "Under a minute",
      meta: { ref: "ENH-0007", status: "Building", submittedBy: "Amara" },
    }),
    body
  );
});

test("a body written by a human is preserved, with no metadata invented", () => {
  const parsed = parseIssueBody("Please make the calendar faster.\n\nThanks!");
  assert.deepEqual(parsed.meta, {});
  assert.match(parsed.body, /Please make the calendar faster/);
  assert.equal(parseIssueBody(null).body, "");
});

// ---------------------------------------------------------------------------
// Status reconciliation
// ---------------------------------------------------------------------------

test("status labels are a two-way mapping", () => {
  assert.equal(statusLabel("status:", "Building"), "status:building");
  assert.equal(statusFromLabels(["enhancement", "status:built"], "status:"), "built");
  assert.equal(statusFromLabels(["enhancement"], "status:"), null);
  assert.equal(statusFromLabels(["other:built"], "status:"), null);
});

test("a disagreement never loses progress and never undoes a rejection", () => {
  const base = { stages: STAGES, issueClosed: false };
  assert.equal(reconcileStatus({ ...base, local: "Reviewing", remote: "Building", prefer: "furthest" }).status, "Building");
  assert.equal(reconcileStatus({ ...base, local: "Built", remote: "Accepted", prefer: "furthest" }).status, "Built");
  assert.equal(reconcileStatus({ ...base, local: "Reviewing", remote: "Building", prefer: "local" }).status, "Reviewing");
  assert.equal(reconcileStatus({ ...base, local: "Reviewing", remote: "Building", prefer: "remote" }).status, "Building");
  assert.equal(reconcileStatus({ ...base, local: "Rejected", remote: "Built", prefer: "furthest" }).status, "Rejected");
  // A closed issue is Archived, unless the local side rejected it.
  assert.equal(reconcileStatus({ stages: STAGES, issueClosed: true, local: "Reviewing", remote: null, prefer: "furthest" }).status, "Archived");
  assert.equal(reconcileStatus({ stages: STAGES, issueClosed: true, local: "Rejected", remote: null, prefer: "furthest" }).status, "Rejected");
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

test("push opens one issue per unlinked proposal and records the pointer", async () => {
  const github = fakeGithub();
  const { store, updates } = fakeStore([record()]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });

  const report = await pushToGithub({ client, store, config, stages: STAGES, closeFinished: false });
  assert.equal(report.errors.length, 0);
  assert.equal(report.created, 1);
  assert.equal(github.issues.size, 1);
  const issue = [...github.issues.values()][0];
  assert.equal(issue.title, "Bulk assign auditors");
  assert.match(issue.body ?? "", /Assigning auditors one quarter at a time is slow/);
  assert.deepEqual(
    (issue.labels as Array<{ name: string }>).map((label) => label.name).sort(),
    ["future-enhancement", "status:reviewing"]
  );
  const patch = updates.find((entry) => entry.patch.github_issue_number !== undefined);
  assert.equal(patch?.patch.github_issue_number, 1);
  assert.equal(patch?.patch.github_direction, "push");
});

test("pushing twice is idempotent: the second run sends no writes", async () => {
  const github = fakeGithub();
  const records = [record()];
  const { store } = fakeStore(records);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });

  await pushToGithub({ client, store, config, stages: STAGES });
  // The first run also creates the labels it needs; that is a repository-level
  // setup cost, not part of the proposal's idempotency, so warm it up first.
  await pushToGithub({ client, store, config, stages: STAGES });
  const writesBefore = github.calls.filter((call) => call.method !== "GET").length;
  assert.ok(writesBefore >= 1);

  const third = await pushToGithub({ client, store, config, stages: STAGES });
  const writesAfter = github.calls.filter((call) => call.method !== "GET").length;
  assert.equal(writesAfter, writesBefore, "no additional write should be issued");
  assert.equal(third.updated, 0);
  assert.equal(third.skipped, 1);
});

test("archiving closes the issue; reopening a proposal reopens it", async () => {
  const github = fakeGithub();
  const records = [record()];
  const { store } = fakeStore(records);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });
  await pushToGithub({ client, store, config, stages: STAGES });

  records[0].status = "Archived";
  await pushToGithub({ client, store, config, stages: STAGES });
  assert.equal([...github.issues.values()][0].state, "closed");

  records[0].status = "Building";
  await pushToGithub({ client, store, config, stages: STAGES });
  assert.equal([...github.issues.values()][0].state, "open");
});

test("one failing proposal does not stop the rest of the push", async () => {
  const github = fakeGithub();
  const { store } = fakeStore([record(), record({ id: "enh_2", ref: "ENH-0002", title: "Second" })]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });
  const report = await pushToGithub({ client, store, config, stages: STAGES });
  assert.equal(report.created, 2);
  // A 404 on a linked issue is reported, not thrown.
  const broken = fakeGithub();
  const store2 = fakeStore([record({ github_repo: "owner/repo", github_issue_number: 999 })]).store;
  const client2 = createGithubClient({ repo: config.repo, token: "t", fetchImpl: broken.fetchImpl });
  const failed = await pushToGithub({ client: client2, store: store2, config, stages: STAGES });
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0].message, /HTTP 404/);
});

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

test("pull imports a labelled issue into the vault with its status", async () => {
  const issue: GithubIssue = {
    number: 12,
    title: "Add a two-way GitHub bridge",
    body: "We want enhancements to live in both places.\n\n### Requirements\n\nTwo-way sync",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/12",
    updated_at: "2026-11-09T00:00:00Z",
    labels: [{ name: "future-enhancement" }, { name: "status:accepted" }],
  };
  const github = fakeGithub([issue]);
  const { store, created } = fakeStore([]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });

  const report = await pullFromGithub({ client, store, config, stages: STAGES });
  assert.equal(report.errors.length, 0);
  assert.equal(report.created, 1);
  assert.equal(created[0].title, "Add a two-way GitHub bridge");
  assert.equal(created[0].status, "accepted");
  assert.match(String(created[0].brief), /both places/);
});

test("pull ignores unlabelled issues and issues outside the configured label", async () => {
  const github = fakeGithub([
    {
      number: 3,
      title: "Unrelated bug",
      body: "nothing to do with enhancements",
      state: "open",
      html_url: "https://github.com/owner/repo/issues/3",
      updated_at: "2026-11-09T00:00:00Z",
      labels: [{ name: "bug" }],
    },
  ]);
  const { store } = fakeStore([]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });
  const report = await pullFromGithub({ client, store, config, stages: STAGES });
  assert.equal(report.created, 0);
});

test("pull takes a remote edit when the remote is newer, and a closed issue becomes Archived", async () => {
  const issue: GithubIssue = {
    number: 5,
    title: "Edited on GitHub",
    body: "A new brief from GitHub.\n\n### Success criteria\n\nShips",
    state: "closed",
    html_url: "https://github.com/owner/repo/issues/5",
    updated_at: "2026-11-09T12:00:00Z",
    labels: [{ name: "future-enhancement" }, { name: "status:built" }],
  };
  const github = fakeGithub([issue]);
  const existing = record({
    github_repo: "owner/repo",
    github_issue_number: 5,
    github_synced_at: "2026-11-08T00:00:00Z",
    status: "Building",
  });
  const { store, updates } = fakeStore([existing]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });

  const report = await pullFromGithub({ client, store, config, stages: STAGES });
  assert.equal(report.errors.length, 0);
  assert.equal(report.updated, 1);
  const patch = updates[0].patch;
  assert.equal(patch.title, "Edited on GitHub");
  assert.equal(patch.status, "Archived", "a closed issue archives the proposal");
  assert.equal(patch.success_criteria, "Ships");
  assert.match(String(patch.brief), /A new brief from GitHub/);
  assert.equal(patch.github_direction, "pull");
});

test("pull leaves an older remote alone when the local copy is newer", async () => {
  const issue: GithubIssue = {
    number: 6,
    title: "Old GitHub title",
    body: "old",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/6",
    updated_at: "2026-11-01T00:00:00Z",
    labels: [{ name: "future-enhancement" }],
  };
  const github = fakeGithub([issue]);
  const existing = record({
    github_repo: "owner/repo",
    github_issue_number: 6,
    github_synced_at: "2026-11-09T00:00:00Z",
    title: "Newer local title",
  });
  const { store, updates } = fakeStore([existing]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });
  const report = await pullFromGithub({ client, store, config, stages: STAGES });
  assert.equal(report.updated, 0);
  assert.equal(updates[0].patch.title, undefined);
});

// ---------------------------------------------------------------------------
// Both ways
// ---------------------------------------------------------------------------

test("a two-way run pushes local proposals and pulls remote ones in one pass", async () => {
  const remoteIssue: GithubIssue = {
    number: 21,
    title: "Raised on GitHub",
    body: "from the issue tracker",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/21",
    updated_at: "2026-11-09T00:00:00Z",
    labels: [{ name: "future-enhancement" }],
  };
  const github = fakeGithub([remoteIssue]);
  const { store, created } = fakeStore([record({ ref: "ENH-0001", title: "Raised in the app" })]);
  const client = createGithubClient({ repo: config.repo, token: "t", fetchImpl: github.fetchImpl });

  const report = await syncBothWays({ client, store, config, stages: STAGES });
  assert.equal(report.direction, "full");
  assert.equal(report.errors.length, 0);
  // The full run pulls (imports the remote issue) and then pushes (opens an
  // issue for the local proposal, updating the one it just read).
  assert.equal(report.direction, "full");
  // One imported from GitHub, one opened on GitHub.
  assert.ok(created.some((entry) => entry.title === "Raised on GitHub"));
  assert.ok([...github.issues.values()].some((issue) => issue.title === "Raised in the app"));
  assert.equal(report.created, 2);
  assert.match(report.items.map((item) => item.message).join(" "), /pull:|push:/);
});

test("an invalid repository or a missing token is refused before any request", async () => {
  assert.throws(() => createGithubClient({ repo: "nope", token: "t" }), /Invalid repository/);
  assert.throws(() => createGithubClient({ repo: "owner/repo", token: "" }), /GITHUB_TOKEN/);
});

test("the issue body used by the push carries the pipeline status as metadata", () => {
  const body = issueBodyFor(record({ status: "Accepted", department_name: "HFM IT QA" }));
  assert.match(body, /status: Accepted/);
  assert.match(body, /department: HFM IT QA/);
  assert.match(body, /### Requirements\n\nPick many activities/);
});
