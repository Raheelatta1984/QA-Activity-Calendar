# Approved future enhancements

The app publishes a handover to `lib/future-enhancements/ENH-*.md` when a
proposal moves to **Building**. Review active `ENH-*.md` files alongside every
change request. Files in `archived/` (and the legacy `archive/` directory) are
completed records and are never reconsidered as active requests.

## Why these files stay in Git (and are not gitignored)

The completion automation is driven by what is committed to `main`:

- the intake workflow watches `lib/future-enhancements/*.md` and creates one
  `arena-handover` development request per Building handover;
- the completion workflow reads the Building/Built document after a merge, moves
  it into `archived/` and rewrites its status to `Archived`;
- every deployment reconciles the in-app status from whichever documents it
  bundles, so `archived/` is what makes a request `Archived`.

Gitignoring the active handovers would therefore hide the approval from the
automation (no development request would ever be raised) and gitignoring the
archived copies would delete the audit trail the status sync reads. Only
generated artefacts are ignored: the reconciliation report is written to
`.tmp/enhancement-docs-sync.md`, which is gitignored, and the local SQLite
database and the in-app vault fallback live in `data/` and `/tmp`.

## Lifecycle

1. A new `ENH-*.md` file pushed to `main` triggers `Enhancement handover intake`.
   The workflow creates one idempotent `arena-handover` issue containing the
   exact filename, source SHA and implementation contract. Use
   `workflow_dispatch` → `all_active` to backfill existing handovers.
2. Arena Agent Mode cannot be started by a repository webhook; open
   <https://arena.ai/agent>, switch to Agent Mode, enable the GitHub connector,
   and paste the issue's ready-to-use prompt into a new session. One Arena
   session supports one PR. No paid GitHub Copilot cloud agent, GitHub Models
   inference, external LLM key or Vercel variable is needed.
3. An implementation PR should reference the request with `Closes #<number>`.
   `Enhancement PR coordination` verifies the linked labelled issue and appends
   `Enhancement-Archive: <full filename>` to the PR body. After `Build and test`
   succeeds on the exact PR head SHA, `Merge passing enhancement PR` squash-merges
   eligible PRs; set `AUTO_MERGE_ENABLED=false` to keep merges manual.
4. After the PR merges into `main`, `Complete enhancement handovers` verifies
   the successful build check, marks the resolved handover(s) **Built**, moves
   them into `lib/future-enhancements/archived/`, changes their status to
   `Archived`, commits directly or through a generated CI-gated archive PR,
   closes the linked request(s), reconciles the in-app status and deletes
   branches within the configured cleanup scope. It is triggered by the merge
   *and* by the CI-gated merge workflow finishing, because a token merge emits
   no `pull_request` closed event.

To complete a pull request that merged before the current triggers existed, run
`Complete enhancement handovers` from the Actions tab with its `pr_number`
input; the same verification and archiving rules apply.

The exact marker line in a PR body is an audit aid. The completion workflow uses
the linked, labelled development request as the authoritative source; an
unbacked marker in an unrelated PR does not archive a handover.

## Safety and limits

- Only same-repository PRs merged into `main` are processed; fork PRs are
  skipped by the CI-gated merge workflow.
- A handover is archived only when it still has `status: "Building"` or
  `status: "Built"` and the merged PR's required build check succeeded.
- Branch cleanup is an allowlist (`copilot/`, `enh/`, `enhancement/`,
  `automation/`, `arena/` by default), not a sweep of every non-`main` branch.
  Protected, unrelated, active or newer branches are preserved. The default
  includes `arena/`, so a merged session head branch is deleted once the session
  finishes and the branch has no newer commits. Active session branches
  (`arena/<session-id>`) are never deleted automatically, and
  `CLEANUP_ALL_MERGED_BRANCHES=true` is only for broader cleanup.
- If branch protection prevents the archive commit from being pushed to `main`,
  a labelled `enhancement-archive` PR is opened and merged after its own
  `Build and test` check succeeds.
- The workflow does not update the application's SQLite enhancement status or
  create the in-app What's New entry. Add that entry as part of implementation.
- Vercel project variables configure the app runtime; GitHub Actions variables
  and secrets are configured separately in GitHub. Neither can make Arena Agent
  Mode start a session automatically.

See [`docs/ENHANCEMENT-AUTOMATION.md`](../../docs/ENHANCEMENT-AUTOMATION.md)
for Vercel variables, GitHub Actions settings, secrets, branch protection and
troubleshooting.
