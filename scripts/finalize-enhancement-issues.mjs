import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubPages, githubRequest, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  ARCHIVED_NAMES_FILE,
  HANDOVER_LABEL,
  ISSUE_NUMBERS_FILE,
  appendStepSummary,
  isSafeHandoverName,
  issueHasLabel,
  parseHandoverMarker,
  readLines,
  unique,
} from "./lib/enhancement-utils.mjs";

export async function runFinalizeIssues(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const repository = repositoryFromEnv(env);
  const archived = unique(readLines(env.ARCHIVED_NAMES_FILE || ARCHIVED_NAMES_FILE)).filter(isSafeHandoverName);
  const issues = unique(readLines(env.ISSUE_NUMBERS_FILE || ISSUE_NUMBERS_FILE)).filter((value) => /^\d+$/.test(value));
  const prNumber = String(env.PR_NUMBER || "").replace(/[^0-9]/g, "");
  const results = [];
  if (!archived.length || !issues.length) {
    appendStepSummary(env, "Development request completion", ["No archived handover and linked issue pair to close."]);
    return results;
  }
  const marker = `<!-- enhancement-completion: PR-${prNumber || "unknown"} -->`;
  for (const number of issues) {
    const { response, data: issue } = await githubRequest(
      env,
      `/repos/${repository.fullName}/issues/${number}`,
      { fetchImpl, allow: [404] },
    );
    if (response.status === 404 || !issue || !issueHasLabel(issue, HANDOVER_LABEL)) continue;
    if (issue.state !== "open") {
      results.push({ issue: number, status: "already-closed" });
      continue;
    }
    const comments = await githubPages(
      env,
      `/repos/${repository.fullName}/issues/${number}/comments?per_page=100`,
      { fetchImpl },
    );
    if (comments.some((comment) => String(comment.body || "").includes(marker))) {
      results.push({ issue: number, status: "already-finalized" });
      continue;
    }
    const ownName = parseHandoverMarker(issue.body);
    const names = ownName && archived.includes(ownName) ? [ownName] : archived;
    const body = [
      marker,
      `Completed by PR #${prNumber || "unknown"}. The required build check passed and these handovers were archived:`,
      ...names.map((name) => `- \`${name}\``),
    ].join("\n");
    await githubRequest(env, `/repos/${repository.fullName}/issues/${number}/comments`, {
      method: "POST",
      body: { body },
      fetchImpl,
    });
    await githubRequest(env, `/repos/${repository.fullName}/issues/${number}`, {
      method: "PATCH",
      body: { state: "closed", state_reason: "completed" },
      fetchImpl,
    });
    results.push({ issue: number, status: "closed" });
  }
  appendStepSummary(
    env,
    "Development request completion",
    results.length
      ? results.map((result) => `#${result.issue}: ${result.status}`)
      : ["No labelled open requests required closing."],
  );
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runFinalizeIssues().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
