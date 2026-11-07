import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function pullRequestEvent({ headRef = "arena/session", headSha = HEAD_SHA } = {}) {
  return {
    pull_request: {
      number: 101,
      body: "Implementation",
      draft: false,
      merged: true,
      labels: [],
      base: { ref: "main" },
      head: { ref: headRef, sha: headSha, repo: { full_name: REPO } },
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

/** Real git checkout so the sweep and head-deletion paths can be exercised. */
function cleanupCheckout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-followup-head-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  run(["init", "-q"]);
  run(["checkout", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "merged head"]);
  return { dir, sha: run(["rev-parse", "HEAD"]).trim() };
}

test("optional full cleanup deletes only fully merged unprotected branches", async (t) => {
  const dir = tempDir(t);
  const deleted = [];
  const mock = router([
    {
      ...exact("GET", `/repos/${REPO}/branches`),
      handler: () => json([
        { name: "main", protected: false },
        { name: "arena/session", protected: false },
        { name: "arena/11863894-qa-activity-calendar", protected: false },
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
  const head = cleanupCheckout(t);
  const result = await runDeleteMergedBranch(
    baseEnv(dir, pullRequestEvent({ headSha: head.sha }), {
      GITHUB_EVENT_NAME: "pull_request",
      CLEANUP_ALL_MERGED_BRANCHES: "true",
      HEAD_BRANCH_DIR: head.dir,
    }),
    { fetchImpl: mock.fetchImpl },
  );
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /active Arena session branch/);
  assert.equal(result.cleanup.status, "completed");
  // The sweep keeps both the live session branch and the bare arena/ branch.
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
  // A merge performed with a workflow token emits no pull_request closed event,
  // so completion must also react to the merge workflow finishing.
  assert.deepEqual(archive.on.workflow_run?.workflows, ["Merge passing enhancement PR"]);
  assert.match(archive.jobs.complete.if, /workflow_run/);
  assert.equal(
    archive.jobs.complete.steps.some((step) => step.run?.includes("mark-handovers-built.mjs")),
    true,
  );
  assert.equal(
    archive.jobs.complete.steps.some((step) => step.run?.includes("sync-enhancement-docs.mjs")),
    true,
  );
  const mergeWorkflow = readWorkflow("merge-after-ci.yml");
  assert.equal(
    mergeWorkflow.jobs.merge.steps.some((step) => step.id === "merge"),
    true,
  );
  assert.equal(
    archive.jobs.complete.steps.some((step) => step.env?.CLEANUP_ALL_MERGED_BRANCHES),
    true,
  );
  // Cleanup must check out the merged head, otherwise it cannot verify whether
  // the branch has newer commits and would have to skip the deletion.
  const cleanupHead = archive.jobs.complete.steps.find(
    (step) => step.id === "cleanup-head",
  );
  assert.ok(cleanupHead, "archive workflow needs a cleanup-head checkout step");
  assert.equal(cleanupHead.with?.path, ".tmp/cleanup-head");
  // The completion workflow runs for a human merge (pull_request) and for a
  // CI-gated workflow merge (workflow_run), so the head is resolved from either.
  assert.match(cleanupHead.with?.ref, /github\.event\.pull_request\.head\.sha/);
  assert.match(cleanupHead.with?.ref, /github\.event\.workflow_run\.head_sha/);
  const cleanupStep = archive.jobs.complete.steps.find(
    (step) => step.run?.includes("delete-merged-branch.mjs"),
  );
  assert.match(cleanupStep.env.HEAD_BRANCH_DIR, /cleanup-head/);
  assert.match(cleanupStep.env.HEAD_BRANCH, /github\.event\.pull_request\.head\.ref/);
  assert.match(cleanupStep.env.HEAD_BRANCH, /github\.event\.workflow_run\.head_branch/);
  const docs = fs.readFileSync(path.join(repoRoot, "docs/ENHANCEMENT-AUTOMATION.md"), "utf8");
  assert.match(docs, /user-initiated/);
  assert.match(docs, /arena\.ai\/agent/);
  assert.match(docs, /GitHub Models/);
  assert.match(docs, /free GitHub plan/);
  assert.match(docs, /AUTO_MERGE_ENABLED/);
  assert.match(docs, /CLEANUP_ALL_MERGED_BRANCHES/);
  assert.match(docs, /Vercel/);
  const intake = readWorkflow("enhancement-intake.yml");
  const intakeStep = intake.jobs["create-development-requests"].steps.find(
    (step) => step.run?.includes("enhancement-intake.mjs"),
  );
  assert.equal(intakeStep?.env?.COPILOT_AGENT_ENABLED, undefined);
  assert.equal(intakeStep?.env?.COPILOT_AGENT_TOKEN, undefined);
  assert.equal(intakeStep?.env?.GITHUB_TOKEN, "${{ github.token }}");
  const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  for (const key of [
    "SESSION_SECRET",
    "APP_TIMEZONE",
    "AI_PROVIDER",
    "SEED_DEMO_DATA",
    "GITHUB_REPO",
    "GITHUB_TOKEN",
    "GITHUB_ENHANCEMENTS_BRANCH",
    "AUTO_MERGE_ENABLED",
    "AUTOMATION_TOKEN",
    "REQUIRED_CHECK_NAME",
    "BRANCH_CLEANUP_PREFIXES",
    "CLEANUP_ALL_MERGED_BRANCHES",
    "ENHANCEMENT_DOC_SYNC",
    "ENHANCEMENT_DOC_SYNC_TIMEOUT_MS",
  ]) {
    assert.match(envExample, new RegExp(`\\b${key}\\b`), `${key} missing from .env.example`);
  }
  assert.match(envExample, /arena\.ai\/agent/);
  assert.doesNotMatch(envExample, /COPILOT_AGENT_/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /automation-followup\.test\.mjs/);
});
