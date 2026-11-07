import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubPages, repositoryFromEnv } from "./lib/github-api.mjs";
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

export async function runVerifyBuild(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const sha = String(env.PR_HEAD_SHA || "").trim();
  if (!isHexSha(sha)) throw new Error("PR_HEAD_SHA must be a 40-character commit SHA.");
  const requiredCheck = String(env.REQUIRED_CHECK_NAME || REQUIRED_CHECK_NAME).trim() || REQUIRED_CHECK_NAME;
  const repository = repositoryFromEnv(env);
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
    `"${requiredCheck}" succeeded on ${sha}.`,
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
