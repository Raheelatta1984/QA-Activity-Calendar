import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  ACTIVE_DIR,
  HANDOVER_LABEL,
  appendGithubOutput,
  appendStepSummary,
  archiveMarker,
  isBuildingHandover,
  isSafeHandoverName,
  issueHasLabel,
  parseArchiveMarkers,
  parseHandoverMarker,
  parseIssueReferences,
  unique,
} from "./lib/enhancement-utils.mjs";

async function readActiveHandover(env, repository, name, ref, fetchImpl) {
  if (!isSafeHandoverName(name)) return null;
  const { response, data } = await githubRequest(
    env,
    `/repos/${repository.fullName}/contents/${ACTIVE_DIR}/${encodeURIComponent(name)}?ref=${encodeURIComponent(ref)}`,
    { fetchImpl, allow: [404] },
  );
  if (response.status === 404 || !data?.content) return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function linkedHandovers(env, repository, pr, fetchImpl) {
  const refs = parseIssueReferences(pr.body, repository.fullName);
  const matches = [];
  for (const number of refs) {
    const { response, data: issue } = await githubRequest(
      env,
      `/repos/${repository.fullName}/issues/${number}`,
      { fetchImpl, allow: [404] },
    );
    if (response.status === 404 || !issue || !issueHasLabel(issue, HANDOVER_LABEL)) continue;
    const name = parseHandoverMarker(issue.body);
    if (!name) continue;
    const content = await readActiveHandover(env, repository, name, pr.base.ref, fetchImpl);
    if (!content || !isBuildingHandover(content)) continue;
    matches.push({ name, issue: number });
  }
  return matches;
}

export async function runLinkPullRequest(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const pr = event.pull_request;
  const skip = (reason) => {
    appendGithubOutput(env, { relevant: "false", handovers: "", reason });
    appendStepSummary(env, "Enhancement PR coordination", [`Skipped: ${reason}`]);
    return { status: "skipped", reason, matches: [] };
  };
  if (!pr) return skip("event has no pull request");
  if (pr.base?.ref !== "main") return skip("base branch is not main");
  if (pr.head?.repo?.full_name !== repository.fullName) return skip("fork PRs are not automated");

  const matches = await linkedHandovers(env, repository, pr, fetchImpl);
  const names = unique(matches.map((match) => match.name));
  const issues = unique(matches.map((match) => match.issue));
  const existingMarkers = parseArchiveMarkers(pr.body);
  const missing = names.filter((name) => !existingMarkers.includes(name));

  if (missing.length) {
    const body = `${String(pr.body || "").trimEnd()}\n\n${missing.map(archiveMarker).join("\n")}\n`;
    await githubRequest(env, `/repos/${repository.fullName}/pulls/${pr.number}`, {
      method: "PATCH",
      body: { body },
      fetchImpl,
    });
  }
  if (names.length) {
    // Labels use the issues API; the label is created by the intake workflow.
    await githubRequest(env, `/repos/${repository.fullName}/issues/${pr.number}/labels`, {
      method: "POST",
      body: { labels: [HANDOVER_LABEL] },
      fetchImpl,
      allow: [404, 422],
    });
  }

  const outputs = {
    relevant: names.length ? "true" : "false",
    handovers: names.join(","),
    issues: issues.join(","),
  };
  appendGithubOutput(env, outputs);
  appendStepSummary(
    env,
    "Enhancement PR coordination",
    names.length
      ? [
          `Linked handovers: ${names.join(", ")}`,
          `Added PR body markers: ${missing.length ? missing.join(", ") : "none (already present)"}`,
          `Linked requests: ${issues.map((number) => `#${number}`).join(", ")}`,
        ]
      : ["No linked, open arena-handover development request found; no automation applied."],
  );
  return { status: names.length ? "linked" : "unrelated", matches, outputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLinkPullRequest().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
