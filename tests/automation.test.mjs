import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import * as utils from "../scripts/lib/enhancement-utils.mjs";
import { buildIssueBody, runIntake } from "../scripts/enhancement-intake.mjs";
import { runLinkPullRequest } from "../scripts/link-enhancement-pr.mjs";
import { latestChecksByName, runVerifyBuild } from "../scripts/verify-pr-build.mjs";
import { runResolvePullRequest } from "../scripts/resolve-pr-handovers.mjs";
import { runFinalizeIssues } from "../scripts/finalize-enhancement-issues.mjs";
import { runDeleteMergedBranch } from "../scripts/delete-merged-branch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "Raheelatta1984/QA-Activity-Calendar";
const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const NAME = "ENH-0003-example-work-enh-123.md";
const OTHER_NAME = "ENH-0004-other-work-enh-456.md";
const BUILDING = `---\nref: "ENH-0003"\ntitle: "Example work"\nstatus: "Building"\n---\n\n# Example\n`;
const encodedContent = (content = BUILDING) => Buffer.from(content, "utf8").toString("base64");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-automation-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(data, status = 200, headers = {}) {
  if (status === 204 || status === 205) return new Response(null, { status, headers });
  return Response.json(data, { status, headers });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exact(method, pathname) {
  return { method, match: new RegExp(`^${method} ${escapeRegex(pathname)}$`) };
}

function router(routes) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, key, init, body });
    for (const route of routes) {
      if (route.method && route.method !== method) continue;
      const matches = route.match instanceof RegExp ? route.match.test(key) : key.includes(route.match);
      if (matches) return route.handler({ url, method, key, init, body, calls });
    }
    throw new Error(`Unexpected request: ${key}`);
  };
  return { fetchImpl, calls };
}

function baseEnv(dir, event, extra = {}) {
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(event));
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: "test-token",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "push",
    GITHUB_OUTPUT: path.join(dir, "output.txt"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
    ...extra,
  };
}

function pushEvent() {
  return {
    before: BEFORE,
    after: AFTER,
    repository: { default_branch: "main", full_name: REPO },
  };
}

function pullRequestEvent({ body = `Closes #7\n\nImplementation`, number = 101, headRef = "copilot/example" } = {}) {
  return {
    pull_request: {
      number,
      body,
      draft: false,
      merged: true,
      labels: [],
      base: { ref: "main" },
      head: { ref: headRef, sha: HEAD_SHA, repo: { full_name: REPO } },
    },
    repository: { default_branch: "main", full_name: REPO },
  };
}

function intakeRoutes({ issueNumber = 42, copilot = false, existing = null } = {}) {
  const createdBodies = [];
  const patchedBodies = [];
  const routes = [
    {
      ...exact("POST", `/repos/${REPO}/issues/42/comments`),
      handler: () => json({ id: 1 }, 201),
    },
    {
      ...exact("POST", `/repos/${REPO}/labels`),
      handler: () => json({ name: "label" }, 201),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/labels\//,
      method: "GET",
      handler: () => json({ message: "Not Found" }, 404),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/compare\//,
      method: "GET",
      handler: () => json({
        files: [
          { status: "added", filename: `lib/future-enhancements/${NAME}` },
          { status: "added", filename: `lib/future-enhancements/archived/${OTHER_NAME}` },
          { status: "modified", filename: "lib/future-enhancements/README.md" },
        ],
      }),
    },
    {
      match: "GET /search/issues",
      handler: () => json({ items: existing ? [existing] : [] }),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/contents\/lib\/future-enhancements\/ENH-/,
      method: "GET",
      handler: () => json({ type: "file", content: encodedContent() }),
    },
    {
      ...exact("POST", `/repos/${REPO}/issues`),
      handler: ({ body }) => {
        createdBodies.push(body);
        return json({ number: issueNumber, html_url: `https://github.com/${REPO}/issues/${issueNumber}` }, 201);
      },
    },
    {
      ...exact("PATCH", `/repos/${REPO}/issues/${issueNumber}`),
      handler: ({ body }) => {
        patchedBodies.push(body);
        return json({ number: issueNumber });
      },
    },
  ];
  if (copilot) {
    routes.unshift({
      ...exact("POST", `/agents/repos/${REPO}/tasks`),
      handler: ({ init }) => {
        assert.equal(init.headers.Authorization, "Bearer copilot-token");
        return json({ id: "task-1", pull_request: { html_url: `https://github.com/${REPO}/pull/99` } }, 201);
      },
    });
  }
  return { routes, createdBodies, patchedBodies };
}

test("shared conventions reject unsafe names and parse authoritative references", () => {
  assert.equal(utils.isSafeHandoverName(NAME), true);
  assert.equal(utils.isSafeHandoverName("../../bad.md"), false);
  assert.deepEqual(
    utils.parseArchiveMarkers(`Enhancement-Archive: ${NAME}\nEnhancement-Archive: ../../bad.md\n  Enhancement-Archive: ${OTHER_NAME}`),
    [NAME],
  );
  assert.equal(utils.parseHandoverMarker(`before ${utils.handoverMarker(NAME)} after`), NAME);
  assert.equal(utils.isBuildingHandover(BUILDING), true);
  assert.equal(utils.isBuildingHandover(BUILDING.replace("Building", "Archived")), false);
  assert.equal(
    utils.handoverTitle('---\ntitle: "  Example <script>  "\nstatus: "Building"\n---\n', "fallback"),
    "Example script",
  );
  assert.deepEqual(
    utils.parseIssueReferences(`Closes #7, fixes #8, GH-9, https://github.com/${REPO}/issues/10, https://github.com/other/repo/issues/11`, REPO),
    [10, 7, 8, 9],
  );
  assert.equal(utils.hasAutomationPrefix("copilot/work", utils.parseBranchPrefixes({})), true);
  assert.equal(utils.hasAutomationPrefix("arena/session", utils.parseBranchPrefixes({})), false);
  assert.throws(() => utils.parseBranchPrefixes({ BRANCH_CLEANUP_PREFIXES: "*" }), /explicit prefixes/);
  assert.equal(utils.isSafeBranchName("enh/../bad"), false);
});

test("issue contract includes Arena limits, exact PR lines and no raw handover content", () => {
  const body = buildIssueBody({ name: NAME, sha: AFTER, issueNumber: 7, title: "Example work", issueUrl: `https://github.com/${REPO}/issues/7` });
  assert.match(body, /<!-- enhancement-handover:/);
  assert.match(body, /user-initiated and cannot be started by this workflow/);
  assert.match(body, /Closes #7/);
  assert.match(body, new RegExp(`Enhancement-Archive: ${NAME.replace(/[.]/g, "\\.")}`));
  assert.match(body, /npm run build/);
  assert.doesNotMatch(body, /Example work is a brief that could be injected/);
});

test("intake creates one issue per newly added Building handover and backfills duplicates idempotently", async (t) => {
  const dir = tempDir(t);
  const first = intakeRoutes();
  const firstRouter = router(first.routes);
  const firstResult = await runIntake(baseEnv(dir, pushEvent()), { fetchImpl: firstRouter.fetchImpl });
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].status, "created");
  assert.equal(firstResult[0].agentStatus, "arena-manual-handoff");
  assert.equal(first.createdBodies[0].labels.includes(utils.HANDOVER_LABEL), true);
  assert.match(first.createdBodies[0].body, /Closes #<issue-number>/);
  assert.match(first.patchedBodies[0].body, /Closes #42/);
  assert.match(fs.readFileSync(path.join(dir, "output.txt"), "utf8"), /requests=1/);

  const existing = {
    title: `Implement handover ${NAME}`,
    body: utils.handoverMarker(NAME),
    html_url: `https://github.com/${REPO}/issues/42`,
  };
  const second = intakeRoutes({ existing });
  const secondRouter = router(second.routes);
  const secondResult = await runIntake(baseEnv(dir, pushEvent()), { fetchImpl: secondRouter.fetchImpl });
  assert.equal(secondResult[0].status, "existing");
  assert.equal(second.createdBodies.length, 0);
});

test("intake can start an optional GitHub Copilot task with the user token", async (t) => {
  const dir = tempDir(t);
  const { routes } = intakeRoutes({ copilot: true });
  const mock = router(routes);
  const result = await runIntake(
    baseEnv(dir, pushEvent(), {
      COPILOT_AGENT_ENABLED: "true",
      COPILOT_AGENT_TOKEN: "copilot-token",
    }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result[0].agentStatus, "copilot-task-started");
  const taskCall = mock.calls.find((call) => call.key === `POST /agents/repos/${REPO}/tasks`);
  assert.equal(taskCall.body.create_pull_request, true);
  assert.match(taskCall.body.prompt, new RegExp(`Closes #42[\\s\\S]*Enhancement-Archive: ${NAME.replace(/[.]/g, "\\.")}`));
  assert.ok(mock.calls.some((call) => call.key === `POST /repos/${REPO}/issues/42/comments`));
});

test("workflow_dispatch all_active backfills approved handovers on main", async (t) => {
  const dir = tempDir(t);
  const created = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/git/ref/heads/main`),
      handler: () => json({ object: { sha: AFTER } }),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/contents\/lib\/future-enhancements$/,
      method: "GET",
      handler: () => json([{ type: "file", name: NAME }, { type: "file", name: "README.md" }]),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/labels\//,
      method: "GET",
      handler: () => json({ name: "exists" }),
    },
    {
      match: "GET /search/issues",
      handler: () => json({ items: [] }),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/contents\/lib\/future-enhancements\/ENH-/,
      method: "GET",
      handler: () => json({ content: encodedContent() }),
    },
    {
      ...exact("POST", `/repos/${REPO}/issues`),
      handler: ({ body }) => {
        created.push(body);
        return json({ number: 55, html_url: `https://github.com/${REPO}/issues/55` }, 201);
      },
    },
    {
      ...exact("PATCH", `/repos/${REPO}/issues/55`),
      handler: () => json({ number: 55 }),
    },
  ]);
  const result = await runIntake(
    baseEnv(dir, { inputs: { mode: "all_active" }, repository: { default_branch: "main" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, NAME);
  assert.equal(created.length, 1);
  assert.ok(mock.calls.some((call) => call.url.pathname.endsWith("/contents/lib/future-enhancements")));
});

test("archive script moves only resolved Building files into archived/ and records results", (t) => {
  const dir = tempDir(t);
  const root = path.join(dir, "lib/future-enhancements");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, NAME), BUILDING);
  fs.writeFileSync(path.join(root, OTHER_NAME), BUILDING.replace("ENH-0003", "ENH-0004"));
  const namesFile = path.join(dir, "names.txt");
  const archivedFile = path.join(dir, "archived.txt");
  fs.writeFileSync(namesFile, `${NAME}\n`);
  const script = path.join(repoRoot, "scripts/archive-enhancements.mjs");
  execFileSync(process.execPath, [script], {
    cwd: dir,
    env: { ...process.env, ARCHIVE_NAMES_FILE: namesFile, ARCHIVED_NAMES_FILE: archivedFile, PR_BODY: "" },
  });
  assert.equal(fs.existsSync(path.join(root, NAME)), false);
  assert.equal(fs.existsSync(path.join(root, OTHER_NAME)), true);
  assert.match(fs.readFileSync(path.join(root, "archived", NAME), "utf8"), /status: "Archived"/);
  assert.equal(fs.readFileSync(archivedFile, "utf8").trim(), NAME);

  fs.writeFileSync(namesFile, "../../bad.md\n");
  assert.throws(() => execFileSync(process.execPath, [script], {
    cwd: dir,
    env: { ...process.env, ARCHIVE_NAMES_FILE: namesFile, ARCHIVED_NAMES_FILE: archivedFile, PR_BODY: "" },
    stdio: "pipe",
  }), /Refusing invalid archive filenames/);
});

test("PR coordination appends exact archive markers from a linked labelled issue", async (t) => {
  const dir = tempDir(t);
  const patched = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/issues/7`),
      handler: () => json({
        number: 7,
        body: utils.handoverMarker(NAME),
        labels: [{ name: utils.HANDOVER_LABEL }],
      }),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/contents\/lib\/future-enhancements\/ENH-/,
      method: "GET",
      handler: () => json({ content: encodedContent() }),
    },
    {
      ...exact("PATCH", `/repos/${REPO}/pulls/101`),
      handler: ({ body }) => {
        patched.push(body);
        return json({ number: 101 });
      },
    },
    {
      ...exact("POST", `/repos/${REPO}/issues/101/labels`),
      handler: () => json([{ name: utils.HANDOVER_LABEL }]),
    },
  ]);
  const result = await runLinkPullRequest(baseEnv(dir, pullRequestEvent(), { GITHUB_EVENT_NAME: "pull_request" }), { fetchImpl: mock.fetchImpl });
  assert.equal(result.status, "linked");
  assert.equal(result.outputs.relevant, "true");
  assert.equal(result.outputs.handovers, NAME);
  assert.match(patched[0].body, new RegExp(`^Enhancement-Archive: ${NAME.replace(/[.]/g, "\\.")}$`, "m"));
  assert.match(fs.readFileSync(path.join(dir, "output.txt"), "utf8"), /relevant=true/);
});

test("unbacked PR markers do not resolve handovers; a labelled manual PR is a documented fallback", async (t) => {
  const dir = tempDir(t);
  const unbackedEnv = baseEnv(dir, pullRequestEvent({ body: `Enhancement-Archive: ${NAME}` }), { GITHUB_EVENT_NAME: "pull_request" });
  const unbacked = await runResolvePullRequest(unbackedEnv, { fetchImpl: router([]).fetchImpl });
  assert.equal(unbacked.relevant, false);
  assert.deepEqual(unbacked.names, []);

  const labelled = pullRequestEvent({ body: `Enhancement-Archive: ${NAME}` });
  labelled.pull_request.labels = [{ name: utils.HANDOVER_LABEL }];
  const fallbackDir = tempDir(t);
  const fallback = await runResolvePullRequest(
    baseEnv(fallbackDir, labelled, { GITHUB_EVENT_NAME: "pull_request" }),
    { fetchImpl: router([]).fetchImpl },
  );
  assert.equal(fallback.relevant, true);
  assert.deepEqual(fallback.names, [NAME]);
});

test("merged PR resolution writes authoritative archive and issue files", async (t) => {
  const dir = tempDir(t);
  const archiveFile = path.join(dir, "archive-names.txt");
  const issuesFile = path.join(dir, "issue-numbers.txt");
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/issues/7`),
      handler: () => json({
        number: 7,
        body: utils.handoverMarker(NAME),
        labels: [{ name: utils.HANDOVER_LABEL }],
      }),
    },
  ]);
  const result = await runResolvePullRequest(
    baseEnv(dir, pullRequestEvent(), {
      GITHUB_EVENT_NAME: "pull_request",
      ARCHIVE_NAMES_FILE: archiveFile,
      ISSUE_NUMBERS_FILE: issuesFile,
    }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result.relevant, true);
  assert.equal(fs.readFileSync(archiveFile, "utf8").trim(), NAME);
  assert.equal(fs.readFileSync(issuesFile, "utf8").trim(), "7");
  assert.match(fs.readFileSync(path.join(dir, "output.txt"), "utf8"), /relevant=true/);
});

test("build verification requires a successful latest Build and test check", async (t) => {
  const dir = tempDir(t);
  const sha = "d".repeat(40);
  const oldFailure = latestChecksByName([
    { id: 1, name: "Build and test", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z", head_sha: sha },
    { id: 2, name: "Build and test", status: "completed", conclusion: "success", started_at: "2026-01-01T00:01:00Z", head_sha: sha },
  ]);
  assert.equal(oldFailure.get("Build and test").conclusion, "success");

  const successRouter = router([
    {
      match: new RegExp(`^GET /repos/${escapeRegex(REPO)}/commits/${sha}/check-runs$`),
      method: "GET",
      handler: () => json({
        check_runs: [
          { id: 1, name: "Build and test", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z", head_sha: sha },
          { id: 2, name: "Build and test", status: "completed", conclusion: "success", started_at: "2026-01-01T00:01:00Z", head_sha: sha },
          { id: 3, name: "CodeQL", status: "completed", conclusion: "neutral", started_at: "2026-01-01T00:02:00Z", head_sha: sha },
        ],
      }),
    },
  ]);
  const result = await runVerifyBuild(baseEnv(dir, {}, { PR_HEAD_SHA: sha }), { fetchImpl: successRouter.fetchImpl });
  assert.equal(result.checkCount, 2);

  const failureRouter = router([
    {
      match: new RegExp(`^GET /repos/${escapeRegex(REPO)}/commits/${sha}/check-runs$`),
      method: "GET",
      handler: () => json({
        check_runs: [{ id: 5, name: "Build and test", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:05:00Z", head_sha: sha }],
      }),
    },
  ]);
  await assert.rejects(
    () => runVerifyBuild(baseEnv(dir, {}, { PR_HEAD_SHA: sha }), { fetchImpl: failureRouter.fetchImpl }),
    /Required check "Build and test" is completed\/failure/,
  );
});

test("issue finalisation closes the linked request with an idempotent completion comment", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "archived.txt"), `${NAME}\n`);
  fs.writeFileSync(path.join(dir, "issues.txt"), "7\n");
  const comments = [];
  const patches = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/issues/7`),
      handler: () => json({
        number: 7,
        state: "open",
        body: utils.handoverMarker(NAME),
        labels: [{ name: utils.HANDOVER_LABEL }],
      }),
    },
    {
      ...exact("GET", `/repos/${REPO}/issues/7/comments`),
      handler: () => json([]),
    },
    {
      ...exact("POST", `/repos/${REPO}/issues/7/comments`),
      handler: ({ body }) => {
        comments.push(body);
        return json({ id: 1 }, 201);
      },
    },
    {
      ...exact("PATCH", `/repos/${REPO}/issues/7`),
      handler: ({ body }) => {
        patches.push(body);
        return json({ number: 7 });
      },
    },
  ]);
  const result = await runFinalizeIssues({
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: "test-token",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
    PR_NUMBER: "101",
    ARCHIVED_NAMES_FILE: path.join(dir, "archived.txt"),
    ISSUE_NUMBERS_FILE: path.join(dir, "issues.txt"),
  }, { fetchImpl: mock.fetchImpl });
  assert.equal(result[0].status, "closed");
  assert.match(comments[0].body, /<!-- enhancement-completion: PR-101 -->/);
  assert.equal(patches[0].state, "closed");
  assert.equal(patches[0].state_reason, "completed");
});

test("branch cleanup preserves Arena sessions and unrelated/newer branches", async (t) => {
  const dir = tempDir(t);
  const arena = await runDeleteMergedBranch(
    baseEnv(dir, pullRequestEvent({ headRef: "arena/session" }), { GITHUB_EVENT_NAME: "pull_request" }),
    { fetchImpl: router([]).fetchImpl },
  );
  assert.equal(arena.status, "skipped");
  assert.match(arena.reason, /preserved/);

  const deleted = [];
  const mock = router([
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/branches\/copilot\//,
      method: "GET",
      handler: () => json({ name: "copilot/example", protected: false }),
    },
    {
      match: /^GET \/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/copilot\//,
      method: "GET",
      handler: () => json({ object: { sha: HEAD_SHA } }),
    },
    {
      match: "GET /repos/",
      handler: ({ url }) => {
        if (url.pathname.endsWith("/pulls")) return json([]);
        throw new Error(`Unexpected cleanup lookup ${url.pathname}`);
      },
    },
    {
      match: /^DELETE \/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/copilot\//,
      method: "DELETE",
      handler: ({ key }) => {
        deleted.push(key);
        return json(null, 204);
      },
    },
  ]);
  const result = await runDeleteMergedBranch(
    baseEnv(dir, pullRequestEvent(), { GITHUB_EVENT_NAME: "pull_request" }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result.status, "deleted");
  assert.equal(deleted.length, 1);
});

test("all workflow YAML parses and the CI gate is wired into completion", () => {
  const workflowDir = path.join(repoRoot, ".github/workflows");
  const workflows = fs.readdirSync(workflowDir).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.includes("ci.yml"));
  assert.ok(workflows.includes("enhancement-intake.yml"));
  assert.ok(workflows.includes("enhancement-pr.yml"));
  assert.ok(workflows.includes("archive-enhancements.yml"));
  for (const name of workflows) {
    const workflow = parseYaml(fs.readFileSync(path.join(workflowDir, name), "utf8"));
    assert.ok(workflow.name, `${name} needs a name`);
    assert.ok(workflow.jobs, `${name} needs jobs`);
    assert.ok(workflow.on, `${name} needs triggers`);
  }
  const ci = parseYaml(fs.readFileSync(path.join(workflowDir, "ci.yml"), "utf8"));
  assert.equal(ci.jobs["build-and-test"].name, "Build and test");
  const intake = parseYaml(fs.readFileSync(path.join(workflowDir, "enhancement-intake.yml"), "utf8"));
  assert.deepEqual(intake.on.push.paths, ["lib/future-enhancements/*.md"]);
  assert.equal(intake.permissions.metadata, undefined);
  assert.match(intake.jobs["create-development-requests"].if, /github\.ref/);
  const completion = parseYaml(fs.readFileSync(path.join(workflowDir, "archive-enhancements.yml"), "utf8"));
  assert.equal(completion.jobs.complete.steps.some((step) => step.run?.includes("verify-pr-build.mjs")), true);
  assert.equal(completion.jobs.complete.steps.some((step) => step.env?.ARCHIVE_NAMES_FILE), true);
  assert.equal(completion.jobs.complete.steps.some((step) => step.run?.includes("delete-merged-branch.mjs")), true);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /automation\.test\.mjs/);
  assert.match(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8"), /archived\//);
  assert.match(fs.readFileSync(path.join(repoRoot, "docs/ENHANCEMENT-AUTOMATION.md"), "utf8"), /user-initiated/);
});
