import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, readGithubEvent, repositoryFromEnv } from "./lib/github-api.mjs";
import {
  ARCHIVE_NAMES_FILE,
  HANDOVER_LABEL,
  ISSUE_NUMBERS_FILE,
  appendGithubOutput,
  appendStepSummary,
  issueHasLabel,
  parseArchiveMarkers,
  parseHandoverMarker,
  parseIssueReferences,
  prHasLabel,
  unique,
  writeLines,
} from "./lib/enhancement-utils.mjs";

export async function runResolvePullRequest(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const event = readGithubEvent(env);
  const repository = repositoryFromEnv(env);
  const archiveFile = env.ARCHIVE_NAMES_FILE || ARCHIVE_NAMES_FILE;

  // A `workflow_run` or `workflow_dispatch` event carries no pull request, so the
  // merged PR is fetched from the number the completion workflow resolved.
  let pr = event.pull_request;
  const requestedPr = String(env.PR_NUMBER || "").replace(/[^0-9]/g, "");
  if (!pr && requestedPr) {
    const { response, data } = await githubRequest(
      env,
      `/repos/${repository.fullName}/pulls/${requestedPr}`,
      { fetchImpl, allow: [404] },
    );
    if (response.status !== 404 && data?.number) pr = data;
  }
  const issuesFile = env.ISSUE_NUMBERS_FILE || ISSUE_NUMBERS_FILE;
  const finish = (names, issues, notes = []) => {
    const safeNames = unique(names);
    const safeIssues = unique(issues.map(String)).filter((value) => /^\d+$/.test(value));
    writeLines(archiveFile, safeNames);
    writeLines(issuesFile, safeIssues);
    appendGithubOutput(env, {
      relevant: safeNames.length ? "true" : "false",
      handovers: safeNames.join(","),
      issues: safeIssues.join(","),
    });
    appendStepSummary(
      env,
      "Merged enhancement resolution",
      safeNames.length
        ? [`Handovers to archive: ${safeNames.join(", ")}`, `Requests to close: ${safeIssues.map((n) => `#${n}`).join(", ") || "none"}`, ...notes]
        : ["No authoritative handover linked to this PR; no files will be archived.", ...notes],
    );
    return { names: safeNames, issues: safeIssues, relevant: safeNames.length > 0 };
  };

  if (!pr || !pr.merged || pr.base?.ref !== "main" || pr.head?.repo?.full_name !== repository.fullName) {
    return finish([], [], ["Not a merged same-repository PR targeting main."]);
  }

  const explicit = parseArchiveMarkers(pr.body);
  const matches = [];
  // The completion workflow can run after the CI-gated merge workflow, when the
  // event is a `workflow_run` and only the PR number is known. Those issue
  // references are resolved from the pull request itself.
  const references = parseIssueReferences(pr.body, repository.fullName);
  for (const number of references) {
    const { response, data: issue } = await githubRequest(
      env,
      `/repos/${repository.fullName}/issues/${number}`,
      { fetchImpl, allow: [404] },
    );
    if (response.status === 404 || !issue || !issueHasLabel(issue, HANDOVER_LABEL)) continue;
    const name = parseHandoverMarker(issue.body);
    if (name) matches.push({ name, issue: number });
  }

  let names = matches.map((match) => match.name);
  const notes = [];
  if (!names.length && explicit.length && prHasLabel(pr, HANDOVER_LABEL)) {
    // Compatibility path for a manually labelled PR: markers alone are never authoritative.
    names = explicit;
    notes.push("Used exact PR markers because the PR carries the arena-handover label.");
  } else if (explicit.length) {
    const unsupported = explicit.filter((name) => !names.includes(name));
    if (unsupported.length) notes.push(`Ignored unbacked PR markers: ${unsupported.join(", ")}.`);
  }
  const issueNumbers = matches.map((match) => match.issue);
  return finish(names, issueNumbers, notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runResolvePullRequest().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
