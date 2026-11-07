# Approved future enhancements

The app publishes a handover to `lib/future-enhancements/ENH-*.md` when a
proposal moves to **Building**. Review active `ENH-*.md` files alongside every
change request. Files in `archived/` (and the legacy `archive/` directory) are
completed records and are never reconsidered as active requests.

## Lifecycle

1. A new `ENH-*.md` file pushed to `main` triggers `Enhancement handover intake`.
   The workflow creates one idempotent `arena-handover` issue containing the
   exact filename, source SHA and implementation contract. Use
   `workflow_dispatch` → `all_active` to backfill existing handovers.
2. Arena Agent Mode cannot be started by a repository webhook; open a new Arena
   coding session from the issue URL with the GitHub connector enabled. One
   Arena session supports one PR. Optionally, the workflow can start a GitHub
   Copilot cloud-agent task instead when `COPILOT_AGENT_ENABLED=true` and
   `COPILOT_AGENT_TOKEN` are configured.
3. An implementation PR should reference the request with `Closes #<number>`.
   `Enhancement PR coordination` verifies the linked labelled issue, appends
   `Enhancement-Archive: <full filename>` to the PR body and can enable gated
   auto-merge after the `Build and test` required check is configured.
4. After the PR merges into `main`, `Complete enhancement handovers` verifies
   the successful build check, moves exactly the resolved Building handover(s)
   into `lib/future-enhancements/archived/`, changes their status to
   `Archived`, commits to `main`, closes the linked request(s), and deletes the
   merged automation head branch only.

The exact marker line in a PR body is an audit aid. The completion workflow uses
the linked, labelled development request as the authoritative source; an
unbacked marker in an unrelated PR does not archive a handover.

## Safety and limits

- Only same-repository PRs merged into `main` are processed.
- A handover is archived only when it still has `status: "Building"` and the
  merged PR's required build check succeeded.
- Branch cleanup is an allowlist (`copilot/`, `enh/`, `enhancement/`,
  `automation/` by default), not a sweep of every non-`main` branch. Protected,
  unrelated, active or newer branches are preserved. Arena session branches
  (`arena/*`) are deliberately excluded by default.
- If branch protection prevents the archive commit from being pushed to `main`,
  the workflow fails visibly; archive through a reviewed PR instead.
- The workflow does not update the application's SQLite enhancement status or
  create the in-app What's New entry. Add that entry as part of implementation.

See [`docs/ENHANCEMENT-AUTOMATION.md`](../../docs/ENHANCEMENT-AUTOMATION.md)
for setup, secrets, branch protection and troubleshooting.
