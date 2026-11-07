import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import * as utils from "../scripts/lib/enhancement-utils.mjs";
import { runMergePassingPullRequest } from "../scripts/merge-passing-pr.mjs";
import { archiveBranchName, runArchivePush } from "../scripts/push-archive-or-pr.mjs";
import { runDeleteMergedBranch } from "../scripts/delete-merged-branch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "Raheelatta1984/QA-Activity-Calendar";
const HEAD_SHA = "c".repeat(40);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-followup-test-"));
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
      if (route.match.test(key)) return route.handler({ url, method, key, init, body, calls });
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
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_OUTPUT: path.join(dir, "output.txt"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
    ...extra,
  };
}

function workflowRunEvent({ headRepository = REPO } = {}) {
  return {
    workflow_run: {
      name: "CI",
      conclusion: "success",
      event: "pull_request",
      head_sha: HEAD_SHA,
      head_repository: { full_name: headRepository },
      workflow: { name: "CI" },
    },
    repository: { default_branch: "main", full_name: REPO },
  };
}

function pullRequestEvent({ headRef = "arena/session" } = {}) {
  return {
    pull_request: {
      number: 101,
      body: "Implementation",
      draft: false,
      merged: true,
      labels: [],
      base: { ref: "main" },
      head: { ref: headRef, sha: HEAD_SHA, repo: { full_name: REPO } },
    },
    repository: { default_branch: "main", full_name: REPO },
  };
}

test("CI-gated merge verifies the exact head SHA and can be disabled or reject forks", async (t) => {
  const dir = tempDir(t);
  const associatedPr = {
    number: 101,
    state: "open",
    draft: false,
    title: "Implement ENH-0003",
    base: { ref: "main" },
    head: { ref: "copilot/example", sha: HEAD_SHA, repo: { full_name: REPO } },
    labels: [{ name: utils.HANDOVER_LABEL }],
  };
  const mergeCalls = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/commits/${HEAD_SHA}/pulls`),
      handler: () => json([associatedPr]),
    },
    {
      ...exact("GET", `/repos/${REPO}/pulls/101`),
      handler: () => json({ ...associatedPr, mergeable: true, mergeable_state: "clean" }),
    },
    {
      ...exact("GET", `/repos/${REPO}/commits/${HEAD_SHA}/check-runs`),
      handler: () => json({
        check_runs: [{
          id: 5,
          name: "Build and test",
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-01T00:05:00Z",
          head_sha: HEAD_SHA,
        }],
      }),
    },
    {
      ...exact("PUT", `/repos/${REPO}/pulls/101/merge`),
      handler: ({ body }) => {
        mergeCalls.push(body);
        return json({ merged: true, sha: "d".repeat(40) });
      },
    },
  ]);
  const env = baseEnv(dir, workflowRunEvent(), {
    AUTO_MERGE_ENABLED: "true",
    REQUIRED_CHECK_NAME: "Build and test",
  });
  const result = await runMergePassingPullRequest(env, {
    fetchImpl: mock.fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.status, "merged");
  assert.equal(result.pullRequest, 101);
  assert.equal(result.sha, HEAD_SHA);
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].merge_method, "squash");
  assert.equal(mergeCalls[0].sha, HEAD_SHA);

  const disabled = await runMergePassingPullRequest(
    baseEnv(dir, workflowRunEvent(), { AUTO_MERGE_ENABLED: "false" }),
    { fetchImpl: router([]).fetchImpl },
  );
  assert.equal(disabled.status, "skipped");
  assert.match(disabled.reason, /AUTO_MERGE_ENABLED/);

  const fork = await runMergePassingPullRequest(
    baseEnv(dir, workflowRunEvent({ headRepository: "attacker/fork" }), {}),
    { fetchImpl: router([]).fetchImpl },
  );
  assert.equal(fork.status, "skipped");
  assert.match(fork.reason, /fork/);
});

test("archive commit uses a labelled CI-gated PR when a direct push is blocked", async (t) => {
  const dir = tempDir(t);
  const env = baseEnv(dir, {}, { GITHUB_EVENT_NAME: "pull_request", PR_NUMBER: "101" });
  const created = [];
  const labelCalls = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/labels/${utils.ARCHIVE_PR_LABEL}`),
      handler: () => json({ message: "Not Found" }, 404),
    },
    {
      ...exact("POST", `/repos/${REPO}/labels`),
      handler: ({ body }) => {
        labelCalls.push(body);
        return json({ name: body.name }, 201);
      },
    },
    {
      ...exact("GET", `/repos/${REPO}/pulls`),
      handler: () => json([]),
    },
    {
      ...exact("POST", `/repos/${REPO}/pulls`),
      handler: ({ body }) => {
        created.push(body);
        return json({ number: 202, html_url: `https://github.com/${REPO}/pull/202` }, 201);
      },
    },
    {
      ...exact("POST", `/repos/${REPO}/issues/202/labels`),
      handler: () => json([{ name: utils.ARCHIVE_PR_LABEL }]),
    },
  ]);
  const gitCommands = [];
  const gitImpl = (args) => {
    gitCommands.push(args.join(" "));
    if (args[0] === "diff" && args[1] === "--cached") throw new Error("staged changes");
    if (args[0] === "push" && args[2] === "HEAD:main") throw new Error("protected branch");
    return Buffer.from("ok");
  };
  const result = await runArchivePush(env, { fetchImpl: mock.fetchImpl, gitImpl });
  assert.equal(result.status, "created-pr");
  assert.equal(result.branch, "automation/archive-pr-101");
  assert.equal(result.pullRequest, 202);
  assert.equal(archiveBranchName("101"), "automation/archive-pr-101");
  assert.ok(gitCommands.includes("push --force origin HEAD:refs/heads/automation/archive-pr-101"));
  assert.equal(labelCalls[0].name, utils.ARCHIVE_PR_LABEL);
  assert.match(created[0].body, /enhancement-archive-pr: 101/);
  assert.equal(created[0].base, "main");

  const direct = await runArchivePush(env, {
    fetchImpl: router([]).fetchImpl,
    gitImpl: (args) => {
      if (args[0] === "diff" && args[1] === "--cached") throw new Error("staged changes");
      return Buffer.from("ok");
    },
  });
  assert.equal(direct.status, "pushed");
});

test("optional full cleanup deletes only fully merged unprotected branches", async (t) => {
  const dir = tempDir(t);
  const deleted = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/branches`),
      handler: () => json([
        { name: "main", protected: false },
        { name: "arena/session", protected: false },
        { name: "feature/merged", protected: false },
        { name: "feature/unmerged", protected: false },
        { name: "protected/keep", protected: true },
      ]),
    },
    {
      ...exact("GET", `/repos/${REPO}/compare/main...feature/merged`),
      handler: () => json({ status: "behind", ahead_by: 0 }),
    },
    {
      ...exact("GET", `/repos/${REPO}/compare/main...feature/unmerged`),
      handler: () => json({ status: "ahead", ahead_by: 2 }),
    },
    {
      ...exact("GET", `/repos/${REPO}/pulls`),
      handler: () => json([]),
    },
    {
      ...exact("DELETE", `/repos/${REPO}/git/refs/heads/feature/merged`),
      handler: ({ key }) => {
        deleted.push(key);
        return json(null, 204);
      },
    },
  ]);
  const result = await runDeleteMergedBranch(
    baseEnv(dir, pullRequestEvent(), {
      GITHUB_EVENT_NAME: "pull_request",
      CLEANUP_ALL_MERGED_BRANCHES: "true",
    }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /preserved/);
  assert.equal(result.cleanup.status, "completed");
  assert.deepEqual(result.cleanup.deleted, ["feature/merged"]);
  assert.equal(deleted.length, 1);
});

test("new workflows, docs and env example wire the limitation fixes", () => {
  const workflowDir = path.join(repoRoot, ".github/workflows");
  const readWorkflow = (name) => parseYaml(fs.readFileSync(path.join(workflowDir, name), "utf8"));
  const merge = readWorkflow("merge-after-ci.yml");
  assert.deepEqual(merge.on.workflow_run.workflows, ["CI"]);
  assert.deepEqual(merge.on.workflow_run.types, ["completed"]);
  assert.match(merge.jobs.merge.if, /conclusion == 'success'/);
  assert.equal(
    merge.jobs.merge.steps.some((step) => step.with?.ref?.includes("default_branch")),
    true,
  );
  assert.equal(
    merge.jobs.merge.steps.some((step) => step.run?.includes("merge-passing-pr.mjs")),
    true,
  );
  const pr = readWorkflow("enhancement-pr.yml");
  assert.equal(
    pr.jobs.coordinate.steps.some((step) => step.run?.includes("enable-auto-merge.mjs")),
    false,
  );
  const archive = readWorkflow("archive-enhancements.yml");
  assert.equal(
    archive.jobs.complete.steps.some((step) => step.run?.includes("push-archive-or-pr.mjs")),
    true,
  );
  assert.equal(
    archive.jobs.complete.steps.some((step) => step.env?.CLEANUP_ALL_MERGED_BRANCHES),
    true,
  );
  const docs = fs.readFileSync(path.join(repoRoot, "docs/ENHANCEMENT-AUTOMATION.md"), "utf8");
  assert.match(docs, /user-initiated/);
  assert.match(docs, /AUTO_MERGE_ENABLED/);
  assert.match(docs, /CLEANUP_ALL_MERGED_BRANCHES/);
  assert.match(docs, /Vercel/);
  const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  for (const key of [
    "SESSION_SECRET",
    "APP_TIMEZONE",
    "AI_PROVIDER",
    "SEED_DEMO_DATA",
    "GITHUB_REPO",
    "GITHUB_TOKEN",
    "GITHUB_ENHANCEMENTS_BRANCH",
    "COPILOT_AGENT_ENABLED",
    "COPILOT_AGENT_TOKEN",
    "AUTO_MERGE_ENABLED",
    "AUTOMATION_TOKEN",
    "REQUIRED_CHECK_NAME",
    "BRANCH_CLEANUP_PREFIXES",
    "CLEANUP_ALL_MERGED_BRANCHES",
  ]) {
    assert.match(envExample, new RegExp(`\\b${key}\\b`), `${key} missing from .env.example`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /automation-followup\.test\.mjs/);
});
