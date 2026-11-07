import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  ARCHIVE_PR_LABEL,
  appendStepSummary,
  encodeBranchPath,
  isSafeBranchName,
} from "./lib/enhancement-utils.mjs";

function defaultGit(args) {
  return execFileSync("git", args, { stdio: "inherit" });
}

function stagedChanges(gitImpl) {
  try {
    gitImpl(["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

export function archiveBranchName(prNumber) {
  const safe = String(prNumber || "unknown").replace(/[^0-9]/g, "") || "unknown";
  const branch = `automation/archive-pr-${safe}`;
  if (!isSafeBranchName(branch)) throw new Error("Generated archive branch name is unsafe.");
  return branch;
}

async function ensureArchiveLabel(env, repository, fetchImpl) {
  const encoded = encodeURIComponent(ARCHIVE_PR_LABEL);
  const existing = await githubRequest(env, `/repos/${repository.fullName}/labels/${encoded}`, {
    fetchImpl,
    allow: [404],
  });
  if (existing.response.status !== 404) return;
  await githubRequest(env, `/repos/${repository.fullName}/labels`, {
    method: "POST",
    body: {
      name: ARCHIVE_PR_LABEL,
      color: "5319e7",
      description: "Generated archive commit awaiting CI-gated merge",
    },
    fetchImpl,
    allow: [422],
  });
}

async function findOpenArchivePr(env, repository, branch, fetchImpl) {
  const head = encodeURIComponent(`${repository.owner}:${branch}`);
  const { data } = await githubRequest(
    env,
    `/repos/${repository.fullName}/pulls?state=open&head=${head}&base=main&per_page=1`,
    { fetchImpl },
  );
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function labelPullRequest(env, repository, number, fetchImpl) {
  await githubRequest(env, `/repos/${repository.fullName}/issues/${number}/labels`, {
    method: "POST",
    body: { labels: [ARCHIVE_PR_LABEL] },
    fetchImpl,
    allow: [422],
  });
}

export async function runArchivePush(
  env = process.env,
  { fetchImpl = globalThis.fetch, gitImpl = defaultGit } = {},
) {
  const repository = repositoryFromEnv(env);
  const prNumber = String(env.PR_NUMBER || "").replace(/[^0-9]/g, "");
  gitImpl(["add", "-A", "lib/future-enhancements"]);
  if (!stagedChanges(gitImpl)) {
    appendStepSummary(env, "Archive commit", ["No staged handover changes to publish."]);
    return { status: "no-changes" };
  }

  gitImpl(["config", "user.name", "github-actions[bot]"]);
  gitImpl(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  gitImpl(["commit", "-m", `docs: archive handovers completed by PR #${prNumber || "unknown"}`]);

  try {
    gitImpl(["pull", "--rebase", "origin", "main"]);
  } catch {
    try {
      gitImpl(["rebase", "--abort"]);
    } catch {
      /* no rebase in progress */
    }
  }
  try {
    gitImpl(["push", "origin", "HEAD:main"]);
    appendStepSummary(env, "Archive commit", ["Pushed the archive commit directly to main."]);
    return { status: "pushed" };
  } catch (error) {
    console.warn(`Direct push to main was blocked (${String(error?.message || error).slice(0, 200)}); using an archive PR.`);
  }

  const branch = archiveBranchName(prNumber);
  gitImpl(["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);
  await ensureArchiveLabel(env, repository, fetchImpl);
  const existing = await findOpenArchivePr(env, repository, branch, fetchImpl);
  if (existing) {
    await labelPullRequest(env, repository, existing.number, fetchImpl);
    appendStepSummary(env, "Archive commit", [
      `Direct push was blocked; updated \`${branch}\` and reused PR #${existing.number}.`,
    ]);
    return { status: "existing-pr", branch, pullRequest: existing.number };
  }

  const created = await githubRequest(env, `/repos/${repository.fullName}/pulls`, {
    method: "POST",
    body: {
      title: `Archive completed enhancement handovers from PR #${prNumber || "unknown"}`,
      head: branch,
      base: "main",
      maintainer_can_modify: true,
      body: [
        `<!-- enhancement-archive-pr: ${prNumber || "unknown"} -->`,
        "",
        "Generated automatically because branch protection prevented a direct archive commit on `main`.",
        "The CI-gated merge workflow will squash-merge this PR after `Build and test` succeeds.",
        "Do not add an `Enhancement-Archive:` line: the handovers were already resolved from the original PR.",
      ].join("\n"),
    },
    fetchImpl,
  });
  const number = created.data?.number;
  if (!number) throw new Error("GitHub did not return an archive PR number.");
  await labelPullRequest(env, repository, number, fetchImpl);
  appendStepSummary(env, "Archive commit", [
    `Direct push was blocked; opened archive PR #${number} from \`${branch}\`.`,
  ]);
  return { status: "created-pr", branch, pullRequest: number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runArchivePush().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
