# Project change guidance

For each change request, review the active approved Markdown handovers in
`lib/future-enhancements/ENH-*.md` as additional context. Do not treat
`lib/future-enhancements/archive/` as active work. Implement only relevant,
authorised requirements; do not claim unrelated handovers are complete.
For each handover fully implemented and tested by a PR, include an exact
`Enhancement-Archive: <full filename>` line in the PR description. The
archive workflow runs only after that PR merges into main. Inspect workflow
results and do not delete unrelated branches.
