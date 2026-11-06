# Approved future enhancements

The app publishes a handover here when its status is moved to Building. Review
all `ENH-*.md` files in this directory alongside each new change request; files
in `archive/` are completed and must not be reconsidered as active requests.

To archive a specific completed handover automatically after its implementation
PR is merged into main, include this exact line in the PR description (one line
per handover, with the actual full filename):

    Enhancement-Archive: ENH-0004-example-enh-uniqueid.md

Only same-repository PRs merged into main are processed. The archive workflow
moves matching Building files into `archive/` in a separate commit. It does not
merge PRs, delete branches, or update the application's SQLite status. Check
the workflow result, especially when branch protection prevents direct pushes;
if it fails, archive through a reviewed PR instead. Never archive a handover
just because an unrelated PR merged.
