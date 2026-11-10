# Decisions, defaults and open questions

Each item records the current behaviour, why, and what would change it. Items marked **Open** need a business confirmation — the app keeps a safe default until then.

## 1. Authentication
**Decision:** local accounts with scrypt password hashes and signed, http-only session cookies for the runnable build.
**Why:** the app must run without an external identity tenant to be testable.
**Production:** replace `lib/auth.ts` with the approved IdP (OIDC/SAML), keep the same `getSession()` contract, enforce MFA and least privilege. **Open** — which IdP and role mapping?

## 2. Visibility is downward-only
**Decision:** a person sees their own sub-tree, never their manager or anyone above. `admin` and `exec` get the holistic view. Unassigned work is visible to managers within their own department.
**Why:** matches the "ariel/holistic" requirement and prevents upward snooping.
**Open:** should peers on the same team see each other's work? Current default: no, unless a manager/exec is viewing.

## 3. Disabled departments
**Decision:** disabled departments are excluded from every operational view (calendars, capacity, reporting, pipeline) for all roles. Admin setup still shows them so they can be re-enabled; records are never deleted.
**Open:** should an exec still see a disabled department in read-only reporting? Default: no.

## 4. Only Active activities count
**Decision:** inactive activities never render, never count in KPIs and never block pipeline work. They remain in the database and can be reactivated.
**Parity note:** some legacy helper formulas omit Active filtering. The app applies the documented rule consistently; the Data Quality queue flags active work inside disabled departments.

## 5. Dates, duration and timezone
**Decision:** date-only fields (`YYYY-MM-DD`), inclusive ranges, `duration = end − start + 1` calendar days. Timestamps are ISO UTC, displayed in `Australia/Sydney`. Fiscal year starts in July; FY27 = Jul 2026 – Jun 2027.
**Why:** source parity and timezone-safe scheduling.

## 6. FTE resolution
**Decision (precedence):** explicit per-record override → Regression default `1` → stored FTE for non-Regression work → configured default `0.5`.
Hours conversion uses a configurable day length: default **7.6h** (source capacity), switchable to 8h. 4h = 0.5 FTE at 8h/day, 0.53 at 7.6h/day. Hours are never invented.
**Open:** confirm the approved hours→FTE divisor for reporting.

## 7. Capacity metric
**Decision:** occupied capacity = `(unavailable + DevOps + recording + QA) / total hours`. Fully unavailable days display "NA". Productive utilisation (QA only) is shown separately. Capacity is kept distinct from FTE demand.
**Why:** the source metric includes absence; treating it as productivity would misreport people.
**Open:** should the headline metric switch to productive utilisation? Default: no.

## 8. NSW public holidays
**Decision:** holidays are supplied configuration. 2026 and 2027 dates are seeded with a "verify against approved source" note. No holiday is ever fetched or invented.
**Action:** verify 2027 (and later) against the approved NSW Industrial Relations source before each fiscal year.

## 9. Deployment date parity
**Decision:** reproduce `start + weeks * 6`, then adjust to the next working day (weekends, NSW holidays) — not an assumed `weeks * 5`. Manual override dates are preserved and take display precedence.
**Open:** confirm whether the source shifts forward or backward on a non-working candidate day. Current default: forward.

## 10. Master Calendar vs Master Calendar (2)
**Decision:** not consolidated. Both are represented by one virtualised month view; meaningful differences would need the workbook to compare formulas.
**Open:** provide both sheets for a formula diff before consolidating.

## 11. QA Calendar display rules
**Decision:** active activities only, with optional pipeline overlay. Prior "activity-only" preferences are not assumed.
**Open:** confirm whether the legacy calendar intentionally hid pipeline rows; current default shows a combined view with a QA-only toggle.

## 12. AI assistance
**Decision:** a deterministic, local insight engine. It computes from the same queries the UI uses and lists its evidence. No operational data leaves the server. `AI_PROVIDER` exists so a hosted model can be added behind the same interface.
**Open:** if a hosted model is approved, complete a data-handling review and store the key in the secret store. Never send employee names or defect detail without approval.

## 13. Progress derivation
**Decision:** completion = `(closed + 0.75 × fixed) / reported`, unless a manual percentage/snapshot exists, which then wins. A bug shared across services is `Closed` only when every link is `Closed`.
**Open:** confirm the weighting for "fixed but unverified" (currently 75%).

## 14. Multi-assignee allocation
**Decision:** `activity_assignments` supports shares, but effort is attributed to the single `assignee_id` until shares are defined. The schema is ready; the UI does not split effort yet.
**Open:** define the allocation-share rule before attributing shared effort to people.

## 15. Import natural keys and unknowns
**Decision:** activities match on Calendar Item ID (falling back to activity + start), pipeline on recording code. Re-running an identical import is a no-op. Unparseable dates stay `NULL` and are queued in Data Quality. Narrative notes longer than 40 characters are archived verbatim rather than becoming activities.
**Why:** idempotency and "unknown stays unknown".

## 16. Overlap / blocking parity
**Decision:** an Active QA activity overlapping a recording day blocks that day. Inactive QA never does. Manual exclusions always win. The source's named-exemption rule — pipeline Days are not blocked where the pipeline title matches the activity's Activity or Activity Detail after trimming and case-insensitive comparison — *is* reproduced by the HFM effective-duration computation (see #25). A match suppresses only that activity's block for that day; an unrelated conflict on the same day still blocks.
**Resolved:** confirmed by the HFM reconciliation spec (2026-11-09). No longer open.

## 17. Demo data separation
**Decision:** synthetic rows carry `is_demo = 1` and are labelled "TEST"/demo in the UI. They are excluded from operational claims and can be removed by resetting a local database. Production instances set `SEED_DEMO_DATA=false`.

## 18. Deployment plan inheritance
**Decision:** application-level status/dates are only inherited when a service-level record exists; nothing is inferred from a plan. Manual overrides are preserved.
**Open:** confirm service-level inheritance rules with the release manager.

## 19. Audit and retention
**Decision:** every mutating action writes an `audit_events` row with actor and before/after JSON. Imported provenance is immutable. Retention period is not enforced by the app.
**Open:** agree retention (e.g. 7 years for release decisions) and any archival job.

## 20. Enhancements and GitHub
**Decision:** enhancements are stored in the database *and* written as Markdown into `enhancements/` in this repository when the filesystem is writable. On read-only serverless bundles (e.g. Vercel `/var/task`, which returns `EROFS`), writes and archive moves fall back automatically to `/tmp/enhancements` and `/api/enhancements/:id` serves the complete YAML-frontmatter Markdown from disk or the database so any proposal can be downloaded and committed to Git. Archiving moves the file to `enhancements/archive/` so it is not reviewed again. A GitHub token is optional; the default flow is a human commit.
**Open:** should the app push directly via the GitHub API in CI? Requires a scoped token and PR policy.

## 21. Serverless storage (Vercel)
**Decision:** when a serverless runtime is detected (Vercel/Lambda/Netlify) or the configured database path is not writable, the app stores SQLite in `/tmp`, embeds the migration SQL into the bundle at build time, and shows a banner that the instance is ephemeral. Session cookies are self-contained signed tokens so a login survives cold starts and instance hops.
**Why:** the first Vercel deployment failed with a generic "server-side exception" because the bundle filesystem is read-only and the runtime could not find or create the database. The app must start cleanly with no configuration.
**Consequence:** on Vercel the demo is fully functional but not a system of record — data is per instance and resets. Postgres is the documented path to durable storage.
**Open:** which managed Postgres (Neon/Vercel Postgres/Supabase) and who owns backups/retention. Until that is chosen, do not put production data in the serverless demo.

## 22. FTE calendar — demand per day, not effort spread over a window
**Decision:** the FTE calendar (`tab.fte`) shows, for each planned testing activity, the FTE it needs **on each day** of the selected month or fiscal quarter. A cell is the activity's effective FTE when the day falls inside its inclusive `[start_date, end_date]` window and blank otherwise. Totals are provided per activity (row), per day (column) and for the whole period.
**Why:** the question being answered is "can we cover Thursday?", not "how big is this piece of work?". Spreading total effort across the window would hide the peak that causes the resourcing problem.
**Rules:** only Active activities with a valid inclusive range contribute; FTE uses the documented precedence (#6); weekends and NSW holidays are shown but excluded from working-day totals so an empty month is never mistaken for zero work. Recording/pipeline rows are excluded by the "Testing activities only" filter, which is on by default.
**Supply:** nominal supply is `headcount × working days` less recorded leave and DevOps hours from the capacity planner. It is a planning ceiling, not a productivity target — a large positive gap usually means non-project work is not yet recorded.
**Open:** should BAU/support time be modelled as an explicit per-person allocation so the gap is tighter? Today it is visible only when recorded in the capacity planner.

## 23. AI drafting is a suggestion, never the author
**Decision:** the enhancement studio drafts options for the outcome, impacted tab/section IDs, title, brief, requirements, impacts, expected outcome, success criteria and markdown handover in real time as the request is typed. Each field offers 1–3 options. A field the author has typed into is never overwritten; accepted drafts are recorded on the proposal (`enhancements.ai_fields`) and in the markdown front matter.
**Why:** the request asked for AI-driven drafting that is always reviewable — the author must be able to accept, edit or ignore any suggestion right up to submission.
**Constraint:** suggestions come from the same deterministic, local engine as the rest of the app (#12). No operational data leaves the server and no hosted model is called.

## 24. HFM import owns structure; humans own confirmation
**Decision:** the HFM snapshot seeds the org scaffold (HarrisFarm Markets company with `is_default = 1`, Harrisfarm entity, `HFM IT QA` department) and the two named people. Damien Milthorpe is seeded as `department_admin` scoped to HFM IT QA with **no email and no password**; Raheel Atta is `admin`, resolved only by the supplied email, reporting to Damien. Unresolved assignee labels (`Sudeep/Mukti`, `Naweesh`, `Tristan`, `Sujan`) stay unassigned and surface as `activity.assignment_review` warnings. The import never invents credentials, people, holidays, emails or relationships, and never fetches reference data from the network.
**Why:** the source workbook names roles and one email; everything else would be invention. Operator-set passwords go through `npm run db:set-password` (audited, never logged).
**Open:** confirm Damien's email/IdP identity before granting him a login in production.

## 25. Pipeline effective duration is live, provisional until holidays are verified
**Decision:** the pipeline board computes a live Monday–Friday duration in the planned window minus the deduplicated union of (a) auto-blocked days (Active master rows with valid inclusive ranges, excluding title/Activity/Detail matches per #16) and (b) manual + global exclusions. Source `Duration Days` snapshots are retained verbatim in `source_duration_days` and never overwritten. NSW holidays are subtracted only when the `holidays.verified` setting is `true` and the holiday table is populated; otherwise the figure is labelled provisional. Blank source automation/status/fraction stay `NULL` — never zero-filled — and are stored as `automation_fraction` (canonical 0–1) with `automation_percent` derived for display.
**Why:** the workbook formula is a snapshot; the operational question is live. Provisional labelling prevents an unverified holiday list from silently shrinking commitments.
**Open:** mark `holidays.verified = true` after the holiday table is verified against the approved NSW source.

## 26. Department moves survive re-import
**Decision:** `department_id` on imported rows is migration-owned only until a human re-parents the row. A re-apply whose source department differs from the current value records a `department_id` conflict in the report and leaves the row where the human put it — it is never silently re-parented. To return a row to source ownership, move it back to `HFM IT QA` before re-importing (no conflict then).
**Why:** a portal edit is a deliberate human act; silently reverting it on refresh would destroy information the workbook cannot express. Conflicts stay visible in the import report; they are not errors.
**Supersedes:** the earlier “overwrite department on re-import” mechanism, which contradicted this file's own comment.

## 27. TEST labels are provenance, not noise
**Decision:** `TEST-*` pipeline rows are retained verbatim (`is_test = 1`, `source_test_label = 1`, `verification_status = 'Needs operational confirmation'`). They are excluded from operational KPIs like any TEST row, and flipping one to `Confirmed operational` requires an application administrator and an audit event (`pipeline.verification_confirmed`). Re-import never downgrades a confirmation. Validation reports `pipeline.needs_confirmation` as info, `activity.assignment_review` as warning.
**Open:** owner (Raheel) to confirm which TEST records, if any, are operational before relying on pipeline totals.

## 28. Rollback is scoped to imported rows
**Decision:** `--rollback <import_batch_id>` deletes only rows whose `import_batch_id` matches the batch (plus their `validation_issues`), marks the batch `rolled_back` and writes audit events. Organisation rows (company/entity/department), people profiles, role grants, settings and demo data survive. Undoing the org scaffold additionally requires restoring the automatic pre-apply backup in `data/backups/`.
**Why:** the workbook is re-importable by construction; deleting org structure blindly could strand portal-owned data that references it.

## 29. Default company scopes login only; it never grants access
**Decision:** the login screen opens on the default company (`is_default = 1`, switchable by an administrator in Master Setup → Companies & entities with an audited `company.set_default` event). A company → entity picker scopes the sign-in roster; demo identities offer one-click fill, imported principals appear with a `credentials not set` badge until an administrator sets a password. Department-less people remain discoverable in the oldest company only. Unknown company/entity URL params fall back silently to the default scope, and an entity from another tenant can never be forced. Changing the default never widens anyone's access — it only chooses which workspace renders first.
**Why:** the workbook contains two legitimate views (the demo tenant and HarrisFarm Markets); showing an undifferentiated account list would mis-signal who can log in where. Every principal is listed by name/role for orientation, but only accounts with credentials can sign in.
**Open:** SSO mapping per entity — until then, credentials stay administrator-set via `db:set-password`.

## 30. The enhancement backlog is shared with GitHub, not exported to it

**Decision:** the Future Enhancements vault and a GitHub repository are kept in
step by a **two-way** bridge (`lib/enhancement-bridge.ts`), not by a one-way
export. A proposal can start in the app or as an issue; after that both stay
live. The engine follows four rules, in this order:

1. **Pull before push.** A full run reads GitHub first, so the local copy has
   seen any edit made on GitHub before anything is written back. A push-only run
   is available but is not the default.
2. **Progress never moves backwards.** When the two statuses disagree the
   furthest-along stage wins (`pipelineStages()` order).
3. **Rejection is terminal.** `Rejected` is a human decision and is never undone
   by a state change upstream. A closed issue archives a proposal, never the
   reverse.
4. **Write only what changed.** Every write is compared against the remote
   payload first, so a scheduled run that finds nothing to do issues no writes
   and the bridge is safe on a timer.

**Why:** the previous integration could only *publish* a handover. Work started
in GitHub had to be transcribed by hand, and a proposal edited upstream was
ignored. A one-way export also creates two backlogs that silently diverge — the
exact failure the vault exists to prevent.
**Why the repository is configuration:** `GITHUB_ENHANCEMENTS_REPO` (env wins
over the setting) points the same deployment at any repository, so the module is
reusable in another GitHub project instead of being welded to this one.
**Deliberately refused:** an unauthenticated sync endpoint (returns `401` when
`ENHANCEMENT_SYNC_SECRET` is unset), auto-resolving a conflict in favour of
whichever side ran last, and decryption of the token outside the server process.
**Open:** GitHub Projects (v2) fields need a user-level token with `project`
scope; issues and linked pull requests are supported today.

## 31. Seeding is conflict-safe and checked inside the write transaction

**Decision:** `seedDemoData()` decides whether demo data is needed **inside** the
same `BEGIN IMMEDIATE` transaction that writes it, and every seeded insert is
conflict-safe (`ON CONFLICT DO NOTHING`, including the `enhancements.ref` UNIQUE
index). A pre-existing row — typically a proposal the GitHub bridge imported —
always wins over demo data instead of colliding with it.

**Why:** two failures were found in review, both from work arriving *outside* the
demo seed:

1. A bridge-imported proposal can legitimately hold `ENH-0002`. Seeding then
   raised `UNIQUE constraint failed: enhancements.ref`; the exception escaped the
   transaction, `bootstrapDatabase()` threw, and the failure surfaced as a failed
   prerender of `/_not-found` — so `npm run build` stopped with a message that
   named neither the seed nor the import.
2. The "already seeded?" guard sat *before* `BEGIN IMMEDIATE`. Next.js builds and
   serves with several processes, each with its own bootstrap, so two of them
   could both decide to seed; the loser hit a constraint while holding the write
   lock. In production the same race is a cold start that throws.

**Never:** silently deleting a real proposal to make room for demo data, or
letting a demo row overwrite an imported one. Demo data is the fallback, not the
authority.
**Pinned by:** `tests/bootstrap-resilience.test.mts` (imported-ref collision and
repeat bootstrap).

## 32. Postgres is a driver, not a rewrite

**Decision:** the data layer is a driver-agnostic facade (`lib/database`). The
SQLite driver (`node:sqlite`) is the local default; the Postgres driver
(`pg`) is used whenever `DATABASE_URL` is set. Both expose the *same synchronous*
`all/get/run/exec/transaction` API, so every module keeps writing one dialect of
SQL and no page, action, script or test knows which store is behind it.

**Why synchronous, in 2026:** the whole application is written against a
synchronous DB surface — server components, server actions, the seed, the
import pipeline, the validation scan. Turning that async to suit `pg` would
touch hundreds of call sites and every test, with no user-visible benefit.
Instead the Postgres driver runs `pg` in a worker thread and blocks the calling
thread on `Atomics.wait`, posting the request through `workerData`/`postMessage`.
The cost (one worker per process) buys a single code path, and the API is the
same one the SQLite driver already had.

**Schema, without a second source of truth:** the migration files stay the
SQLite-flavoured SQL the app has always used. On a fresh Postgres database the
driver replays them into an in-memory SQLite engine, converts `sqlite_master`
into Postgres DDL (`lib/database/pg-schema.ts`) and applies it as the baseline
`pg-baseline@005_release_planning.sql`. Migrations added later are translated per
statement (`lib/database/dialect.ts`). Two hand-maintained schemas would drift;
a generated one cannot. Anything without an equivalent (`sqlite_master`,
`rowid`, `INSERT OR REPLACE`) throws instead of being silently mangled.

**Fallback is loud or absent:** a missing/unreachable database falls back to
SQLite so a laptop always runs, but `DATABASE_REQUIRE_POSTGRES=true` (and
`DATABASE_DRIVER=postgres`) makes that impossible in production, and
`/api/health` always reports `driver`, `durable` and `fallbackReason`.

**Consequences:** `pg` must stay a real node package (`serverExternalPackages`)
because the bridge `require()`s it at runtime; a pool of one still works because
statements inside a transaction use the reserved client; PGlite is a
devDependency that lets CI exercise the real driver over the Postgres wire
protocol.

**Pinned by:** `tests/postgres.test.mts` (translation, schema generation,
baseline), `tests/postgres-driver.test.mts` (live driver: migration, queries,
constraints, transactions, release/FTE reads) and `tests/releases.test.mts`
(release windows and FTE).

## 33. A release contributes FTE through its window and assignees

**Decision:** `release_feed` carries an inclusive QA window
(`qa_start_date`/`qa_end_date`) and `release_assignees` carries the people and
their FTE share **per working day**. Release demand = Σ shares × working days in
the window (Mon–Fri minus NSW holidays), hours = FTE-days × the configured day
length. The same computation feeds the Releases tab, the QA calendar (`REL`
chips over the days) and the FTE calendar (a `Release` group with its own rows
and a per-day column contribution).

**Why:** a single release date cannot answer "how much QA is this release and
when", and a release with a window but no assignees would inflate demand with
nobody to do the work. So a window without assignees is an explicit `Unassigned`
row with 0 FTE and a `release.qa_window_unassigned` warning — visible, never
invented.

**Never:** storing FTE-days as the input (a window edit would silently change
effort — the share is the input, effort is derived), deriving release demand
from activities (a release is governance, not an activity; it must not appear as
one), or counting calendar days (weekends and NSW holidays are not effort).

**Pinned by:** `tests/releases.test.mts` (window maths, FTE-days, unassigned
gap, validation, cascade delete, calendar/FTE integration).
