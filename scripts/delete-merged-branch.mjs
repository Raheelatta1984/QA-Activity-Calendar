import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  appendStepSummary,
  encodeBranchPath,
  hasAutomationPrefix,
  isHexSha,
  isSafeBranchName,
  parseBranchPrefixes,
} from "./lib/enhancement-utils.mjs";

export async function runDeleteMergedBranch(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const pr = event.pull_request;
  const skip = (reason) => {
    appendStepSummary(env, "Merged branch cleanup", [`Skipped: ${reason}`]);
    return { status: "skipped", reason };
  };
  if (!pr || !pr.merged) return skip("PR was not merged");
  if (pr.head?.repo?.full_name !== repository.fullName) return skip("fork PR head branch");
  const branch = String(pr.head?.ref || "");
  const defaultBranch = event.repository?.default_branch || "main";
  if (branch === defaultBranch || branch === "main") return skip("default/main branch is never deleted");
  if (!isSafeBranchName(branch)) return skip("unsafe branch name");
  if (!hasAutomationPrefix(branch, parseBranchPrefixes(env))) {
    return skip("branch is outside BRANCH_CLEANUP_PREFIXES; unrelated branches are preserved");
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

  const open = await githubRequest(
    env,
    `/repos/${repository.fullName}/pulls?state=open&head=${encodeURIComponent(`${repository.owner}:${branch}`)}&per_page=1`,
    { fetchImpl },
  );
  if (Array.isArray(open.data) && open.data.length) return skip("branch still has an open pull request");

  const deleted = await githubRequest(env, `/repos/${repository.fullName}/git/refs/heads/${encoded}`, {
    method: "DELETE",
    fetchImpl,
    allow: [404, 422],
  });
  if (deleted.response.status >= 300) return skip("branch was already deleted or could not be removed");
  appendStepSummary(env, "Merged branch cleanup", [`Deleted merged automation branch \`${branch}\`.`]);
  return { status: "deleted", branch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDeleteMergedBranch().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
