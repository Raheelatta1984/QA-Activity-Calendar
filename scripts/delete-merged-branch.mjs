import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { githubPages, githubRequest, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  appendStepSummary,
  encodeBranchPath,
  envFlag,
  hasAutomationPrefix,
  isHexSha,
  isSafeBranchName,
  parseBranchPrefixes,
  PROTECTED_SESSION_PREFIXES,
  resolveWorkingDirectory,
} from "./lib/enhancement-utils.mjs";

function git(directory, args) {
  try {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The commit the merged head branch points at in the local checkout. */
async function resolveWorkingTreeSha(directory) {
  return git(directory, ["rev-parse", "HEAD"]);
}

/** Soft availability check: a missing commit or git failure preserves the branch. */
async function branchHasNewerCommits(directory, branch, mergedSha) {
  if (!isHexSha(mergedSha)) return true;
  const tip = git(directory, ["rev-parse", `refs/remotes/origin/${branch}`])
    || git(directory, ["rev-parse", branch]);
  if (!isHexSha(tip) || tip === mergedSha) return false;
  const unmerged = git(directory, ["rev-list", "--count", `${mergedSha}..${tip}`]);
  if (unmerged === "") return true;
  return Number(unmerged) > 0;
}

async function branchHasOpenPr(env, repository, branch, fetchImpl) {
  const head = encodeURIComponent(`${repository.owner}:${branch}`);
  const { data } = await githubRequest(
    env,
    `/repos/${repository.fullName}/pulls?state=open&head=${head}&per_page=1`,
    { fetchImpl },
  );
  return Array.isArray(data) && data.length > 0;
}

async function deleteHeadBranch(env, repository, event, fetchImpl) {
  const pr = event.pull_request;
  const skip = (reason) => {
    appendStepSummary(env, "Merged branch cleanup", [`Head branch skipped: ${reason}`]);
    return { status: "skipped", reason };
  };
  if (!pr || !pr.merged) return skip("PR was not merged");
  if (pr.head?.repo?.full_name !== repository.fullName) return skip("fork PR head branch");
  const branch = String(pr.head?.ref || "");
  const defaultBranch = event.repository?.default_branch || "main";
  if (branch === defaultBranch || branch === "main") return skip("default/main branch is never deleted");
  if (!isSafeBranchName(branch)) return skip("unsafe branch name");

  // Checked after the safe-name and default-branch guards, so a malformed
  // branch name is still reported as unsafe.
  const workingDirectory = resolveWorkingDirectory(env);
  if (workingDirectory !== path.resolve(workingDirectory) || !fs.existsSync(workingDirectory)) {
    return skip("cannot resolve the merged head working directory");
  }
  const headSha = await resolveWorkingTreeSha(workingDirectory);
  if (!isHexSha(headSha)) {
    return skip("merged head working tree is not a readable git checkout");
  }
  if (headSha !== String(pr.head?.sha || "")) {
    return skip("local HEAD is not the merged PR head; refusing to judge branch activity");
  }

  if (!hasAutomationPrefix(branch, parseBranchPrefixes(env))) {
    return skip("branch is outside BRANCH_CLEANUP_PREFIXES; unrelated branches are preserved");
  }
  const sessionPrefix = PROTECTED_SESSION_PREFIXES.find((prefix) => branch.startsWith(prefix));
  if (sessionPrefix) {
    return skip(
      `active Arena session branch (${sessionPrefix}); never deleted automatically by any prefix setting`,
    );
  }
  const sha = String(pr.head?.sha || "");
  if (!isHexSha(sha)) return skip("missing valid PR head SHA");

  const encoded = encodeBranchPath(branch);
  const branchInfo = await githubRequest(env, `/repos/${repository.fullName}/branches/${encoded}`, {
    fetchImpl,
    allow: [403, 404],
  });
  if (branchInfo.response.status !== 200 || branchInfo.data?.protected) {
    return skip("branch is protected or its protection cannot be read");
  }
  const ref = await githubRequest(env, `/repos/${repository.fullName}/git/ref/heads/${encoded}`, {
    fetchImpl,
    allow: [404],
  });
  if (ref.response.status !== 200 || ref.data?.object?.sha !== sha) {
    return skip("branch tip differs from the merged PR head; preserving newer commits");
  }
  if (await branchHasOpenPr(env, repository, branch, fetchImpl)) {
    return skip("branch still has an open pull request");
  }
  if (await branchHasNewerCommits(workingDirectory, branch, sha)) {
    return skip("branch has commits that are not in the merged PR head; preserving newer commits");
  }
  const deleted = await githubRequest(env, `/repos/${repository.fullName}/git/refs/heads/${encoded}`, {
    method: "DELETE",
    fetchImpl,
    allow: [404, 422],
  });
  if (deleted.response.status >= 300) return skip("branch was already deleted or could not be removed");
  appendStepSummary(env, "Merged branch cleanup", [`Deleted merged automation head branch \`${branch}\`.`]);
  return { status: "deleted", branch };
}

async function cleanupAllMergedBranches(env, repository, event, headBranch, fetchImpl) {
  const defaultBranch = event.repository?.default_branch || "main";
  const branches = await githubPages(
    env,
    `/repos/${repository.fullName}/branches?per_page=100`,
    { fetchImpl },
  );
  const deleted = [];
  for (const entry of branches) {
    const branch = String(entry?.name || "");
    if (!branch || branch === defaultBranch || branch === "main" || branch === headBranch) continue;
    if (entry.protected || !isSafeBranchName(branch)) continue;
    if (PROTECTED_SESSION_PREFIXES.some((prefix) => branch.startsWith(prefix))) continue;
    const encoded = encodeBranchPath(branch);
    const compare = await githubRequest(
      env,
      `/repos/${repository.fullName}/compare/${encodeBranchPath(defaultBranch)}...${encoded}`,
      { fetchImpl, allow: [404] },
    );
    const fullyMerged = compare.response.status === 200 &&
      Number(compare.data?.ahead_by ?? 1) === 0 &&
      ["identical", "behind"].includes(String(compare.data?.status || ""));
    if (!fullyMerged) continue;
    if (await branchHasOpenPr(env, repository, branch, fetchImpl)) continue;
    const response = await githubRequest(env, `/repos/${repository.fullName}/git/refs/heads/${encoded}`, {
      method: "DELETE",
      fetchImpl,
      allow: [403, 404, 422],
    });
    if (response.response.status < 300) deleted.push(branch);
  }
  appendStepSummary(env, "Optional full branch cleanup", [
    `CLEANUP_ALL_MERGED_BRANCHES=true; deleted ${deleted.length} fully merged, unprotected branch(es).`,
    ...deleted.map((branch) => `Deleted \`${branch}\`.`),
  ]);
  return { status: "completed", deleted };
}

export async function runDeleteMergedBranch(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const headBranch = String(event.pull_request?.head?.ref || "");
  const head = await deleteHeadBranch(env, repository, event, fetchImpl);
  const cleanup = envFlag(env, "CLEANUP_ALL_MERGED_BRANCHES", false)
    ? await cleanupAllMergedBranches(env, repository, event, headBranch, fetchImpl)
    : { status: "disabled" };
  return { ...head, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDeleteMergedBranch().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
