import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  ARCHIVE_PR_LABEL,
  HANDOVER_LABEL,
  appendStepSummary,
  envFlag,
  isHexSha,
  prHasLabel,
} from "./lib/enhancement-utils.mjs";
import { runVerifyBuild } from "./verify-pr-build.mjs";

const ALLOWED_LABELS = [HANDOVER_LABEL, ARCHIVE_PR_LABEL];

function eligiblePullRequest(pr, repository, defaultBranch, sha) {
  return (
    pr?.state === "open" &&
    pr.base?.ref === defaultBranch &&
    pr.head?.ref &&
    pr.head?.sha === sha &&
    pr.head?.repo?.full_name === repository.fullName &&
    pr.draft !== true &&
    ALLOWED_LABELS.some((label) => prHasLabel(pr, label))
  );
}

async function waitForMergeability(env, repository, number, fetchImpl, sleepImpl) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { response, data: pr } = await githubRequest(
      env,
      `/repos/${repository.fullName}/pulls/${number}`,
      { fetchImpl, allow: [404] },
    );
    if (response.status === 404) return null;
    if (pr.mergeable === false || pr.state !== "open") return null;
    if (pr.mergeable === true) return pr;
    if (attempt < 3) await sleepImpl(1000);
  }
  return null;
}

export async function runMergePassingPullRequest(
  env = process.env,
  { fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const run = event.workflow_run;
  const skip = (reason) => {
    appendStepSummary(env, "CI-gated merge", [`Skipped: ${reason}`]);
    return { status: "skipped", reason };
  };
  if (!envFlag(env, "AUTO_MERGE_ENABLED", true)) return skip("AUTO_MERGE_ENABLED is false");
  if (!run) return skip("event has no workflow_run");
  if (run.conclusion !== "success") return skip("CI did not succeed");
  if (run.event !== "pull_request") return skip("CI run was not triggered by a pull request");
  const workflowName = String(run.name || run.workflow?.name || "");
  if (workflowName !== "CI") return skip("workflow is not CI");
  const headRepository = run.head_repository?.full_name || event.repository?.full_name;
  if (headRepository !== repository.fullName) return skip("CI head repository is a fork");
  const sha = String(run.head_sha || "");
  if (!isHexSha(sha)) return skip("CI run has no valid head SHA");
  const defaultBranch = event.repository?.default_branch || "main";

  const associated = await githubRequest(
    env,
    `/repos/${repository.fullName}/commits/${sha}/pulls?per_page=100`,
    { fetchImpl },
  );
  const candidate = (Array.isArray(associated.data) ? associated.data : [])
    .find((pr) => eligiblePullRequest(pr, repository, defaultBranch, sha));
  if (!candidate) return skip("no eligible open enhancement or archive PR for this exact head SHA");

  const pr = await waitForMergeability(env, repository, candidate.number, fetchImpl, sleepImpl);
  if (!pr) return skip(`PR #${candidate.number} is not mergeable at this head SHA`);
  if (pr.head?.sha !== sha) return skip("PR head advanced after CI completed");

  await runVerifyBuild({ ...env, PR_HEAD_SHA: sha }, { fetchImpl });

  const merged = await githubRequest(env, `/repos/${repository.fullName}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: {
      merge_method: "squash",
      sha,
      commit_title: `${pr.title || `PR #${pr.number}`} (#${pr.number})`,
      commit_message: `Merged automatically after the CI \"Build and test\" check succeeded on ${sha}.`,
    },
    fetchImpl,
    allow: [405, 409, 422],
  });
  if (merged.response.status >= 300) {
    const detail = merged.data?.message || "GitHub refused the merge";
    throw new Error(`Could not merge PR #${pr.number}: ${detail}`);
  }
  if (merged.data?.merged !== true) return skip(`GitHub did not merge PR #${pr.number}`);
  appendStepSummary(env, "CI-gated merge", [
    `Squash-merged PR #${pr.number} at ${sha} after the required build check succeeded.`,
  ]);
  return { status: "merged", pullRequest: pr.number, sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMergePassingPullRequest().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
