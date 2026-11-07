import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, graphqlUrl, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  REQUIRED_CHECK_NAME,
  appendStepSummary,
  hasAutomationPrefix,
  parseBranchPrefixes,
} from "./lib/enhancement-utils.mjs";

export function hasRequiredCheck(data, checkName) {
  const contexts = [...(data?.contexts || []), ...(data?.checks || []).map((check) => check?.context)];
  return contexts.some((context) => String(context) === checkName);
}

export async function runEnableAutoMerge(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  if (env.AUTO_MERGE_ENABLED !== "true") {
    appendStepSummary(env, "Auto-merge", ["Disabled by AUTO_MERGE_ENABLED."]);
    return { status: "disabled" };
  }
  const token = String(env.AUTOMATION_TOKEN || "").trim();
  if (!token) throw new Error("AUTOMATION_TOKEN is required when AUTO_MERGE_ENABLED=true.");

  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const pr = event.pull_request;
  const skip = (reason) => {
    appendStepSummary(env, "Auto-merge", [`Skipped: ${reason}`]);
    return { status: "skipped", reason };
  };
  if (!pr) return skip("event has no pull request");
  if (pr.base?.ref !== "main") return skip("base branch is not main");
  if (pr.head?.repo?.full_name !== repository.fullName) return skip("fork PRs are not automated");
  if (pr.draft) return skip("draft PR");
  if (!hasAutomationPrefix(pr.head?.ref, parseBranchPrefixes(env))) {
    return skip("head branch is not in BRANCH_CLEANUP_PREFIXES");
  }

  const requiredCheck = String(env.REQUIRED_CHECK_NAME || REQUIRED_CHECK_NAME).trim() || REQUIRED_CHECK_NAME;
  const protection = await githubRequest(
    env,
    `/repos/${repository.fullName}/branches/main/protection/required_status_checks`,
    { token, fetchImpl, allow: [403, 404] },
  );
  if (protection.response.status !== 200 || !hasRequiredCheck(protection.data, requiredCheck)) {
    throw new Error(
      `Auto-merge refused: main must have a required status check named "${requiredCheck}", and AUTOMATION_TOKEN must be able to read branch protection.`,
    );
  }

  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { id autoMergeRequest { enabledAt } }
    }
  }`;
  const current = await githubRequest(env, graphqlUrl(env), {
    method: "POST",
    token,
    body: { query, variables: { owner: repository.owner, name: repository.name, number: pr.number } },
    fetchImpl,
  });
  if (current.data?.errors?.length) throw new Error(`GraphQL lookup failed: ${current.data.errors[0].message}`);
  const pullRequest = current.data?.data?.repository?.pullRequest;
  if (!pullRequest?.id) throw new Error("Could not resolve the pull request GraphQL id.");
  if (pullRequest.autoMergeRequest) {
    appendStepSummary(env, "Auto-merge", ["Already enabled; waiting for required checks."]);
    return { status: "already-enabled" };
  }

  const mutation = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId,
      mergeMethod: $mergeMethod
    }) { clientMutationId }
  }`;
  const enabled = await githubRequest(env, graphqlUrl(env), {
    method: "POST",
    token,
    body: {
      query: mutation,
      variables: { pullRequestId: pullRequest.id, mergeMethod: "SQUASH" },
    },
    fetchImpl,
  });
  if (enabled.data?.errors?.length) throw new Error(`Auto-merge failed: ${enabled.data.errors[0].message}`);
  appendStepSummary(env, "Auto-merge", [`Enabled for PR #${pr.number}; merge waits for "${requiredCheck}".`]);
  return { status: "enabled", pullRequest: pr.number, requiredCheck };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEnableAutoMerge().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
