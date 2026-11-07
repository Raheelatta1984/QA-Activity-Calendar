import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubPages, githubRequest, repositoryFromEnv } from "./lib/github-api.mjs";
import { REQUIRED_CHECK_NAME, appendStepSummary, isHexSha } from "./lib/enhancement-utils.mjs";

function latestRunKey(run) {
  return `${String(run.started_at || run.created_at || "")}|${String(run.id || "").padStart(24, "0")}`;
}

export function latestChecksByName(runs) {
  const latest = new Map();
  for (const run of runs) {
    const name = String(run.name || "");
    if (!name) continue;
    const previous = latest.get(name);
    if (!previous || latestRunKey(run) > latestRunKey(previous)) latest.set(name, run);
  }
  return latest;
}

const PR_NUMBER_RE = /^[0-9]+$/;

/** The PR head SHA to verify: explicit, else looked up from the pull request. */
async function resolveHeadSha(env, repository, fetchImpl) {
  const explicit = String(env.PR_HEAD_SHA || "").trim();
  if (explicit) return explicit;
  const prNumber = String(env.PR_NUMBER || "").trim();
  if (!PR_NUMBER_RE.test(prNumber)) {
    throw new Error("PR_HEAD_SHA or PR_NUMBER must identify the merged pull request.");
  }
  const { data } = await githubRequest(env, `/repos/${repository.fullName}/pulls/${prNumber}`, { fetchImpl });
  const sha = String(data?.head?.sha || "").trim();
  if (!isHexSha(sha)) throw new Error(`Pull request #${prNumber} has no valid head SHA.`);
  return sha;
}

export async function runVerifyBuild(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const repositoryForSha = repositoryFromEnv(env);
  const sha = await resolveHeadSha(env, repositoryForSha, fetchImpl);
  if (!isHexSha(sha)) throw new Error("PR_HEAD_SHA must be a 40-character commit SHA.");
  const requiredCheck = String(env.REQUIRED_CHECK_NAME || REQUIRED_CHECK_NAME).trim() || REQUIRED_CHECK_NAME;
  const repository = repositoryForSha;
  const runs = await githubPages(
    env,
    `/repos/${repository.fullName}/commits/${sha}/check-runs?per_page=100&filter=all`,
    {
      fetchImpl,
      extract: (data) => (Array.isArray(data?.check_runs) ? data.check_runs : []),
    },
  );
  if (!runs.length) throw new Error(`No check runs were found for ${sha}; refusing to archive.`);
  const latest = latestChecksByName(runs.filter((run) => run.head_sha === sha));

  const build = latest.get(requiredCheck);
  if (!build || build.status !== "completed" || build.conclusion !== "success") {
    const state = build ? `${build.status}/${build.conclusion || "pending"}` : "missing";
    throw new Error(`Required check "${requiredCheck}" is ${state} for ${sha}; refusing to archive.`);
  }
  const failures = [...latest.entries()]
    .filter(([, run]) => ["failure", "timed_out", "cancelled", "action_required", "stale"].includes(run.conclusion))
    .map(([name, run]) => `${name} (${run.conclusion})`);
  if (failures.length) throw new Error(`Other latest checks failed for ${sha}: ${failures.join(", ")}.`);

  appendStepSummary(env, "Build verification", [
    `"${requiredCheck}" succeeded on ${sha}${String(env.PR_NUMBER || "").trim() ? ` (PR #${String(env.PR_NUMBER).trim()})` : ""}.`,
    `${latest.size} latest check run(s) inspected; no failed checks.`,
  ]);
  return { sha, requiredCheck, checkCount: latest.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runVerifyBuild().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
