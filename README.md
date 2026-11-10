# HFM QA Activity Calendar

An AI-assisted QA operations workspace that replaces the HFM QA activity workbook: activities, recording pipeline, capacity, releases and defect reporting in one persistent, role-aware application.

Built to the handover in [`ReadTheProjectMDfile.md`](./ReadTheProjectMDfile.md). It is a **working application**, not a prototype: a real database with migrations and a Postgres driver, import tooling, tests and deployment notes. The legacy workbook is never modified — data is imported as text with full provenance.

```bash
npm install
cp .env.example .env            # optional for local dev; defaults are safe
npm run db:migrate && npm run db:seed
npm run dev                     # http://localhost:3000
```

**Storage.** One data layer, two interchangeable drivers, chosen by
configuration only:

| `DATABASE_URL` | Driver | Used for |
| --- | --- | --- |
| `postgres://…` | `pg` (worker-backed, same synchronous API) | production — durable, shared by every instance |
| unset | `node:sqlite` at `DATABASE_FILE` | local development, tests, demos |

Both run the same schema, the same migrations and the same SQL, so nothing in
the app branches on the driver. `DATABASE_REQUIRE_POSTGRES=true` makes a
connection failure a startup error rather than a silent fallback, and
`/api/health` always reports `driver`, `durable` and `fallbackReason`. See
[DEPLOYMENT §3.1](./docs/DEPLOYMENT.md#31-durable-storage-postgres).

Demo identities all use the password `demo1234`:

| Person | Email | Role | Sees |
| --- | --- | --- | --- |
| Amara Okafor | `amara.okafor@hfm.demo` | admin | everything |
| Lachlan Reid | `lachlan.reid@hfm.demo` | manager | QA team sub-tree |
| Sofia Marchetti | `sofia.marchetti@hfm.demo` | editor | own work only |
| Hana Suzuki | `hana.suzuki@hfm.demo` | viewer | own work only |
| Priya Raman | `priya.raman@hfm.demo` | exec | holistic, read-mostly |

---

## HFM workbook import

The HarrisFarm Markets QA workbook snapshot (2026-11-09) ships embedded in this repository. After migrate + seed:

```bash
npm run db:hfm-import              # dry-run — writes nothing
npm run db:hfm-import -- --apply   # commit (automatic backup first)
npm run db:hfm-import -- --verify  # 23 read-only acceptance checks
npm run db:provision              # create/reconcile the separate HFM2 tenant
npm run db:inject-tenant          # preview the HFM → HFM2 copy
npm run db:inject-tenant -- --apply --confirm COPY   # create a reversible copy batch
npm run db:inject-tenant -- --delete <batch-id> --confirm DELETE
```

It seeds the demo workspace and the HFM org (HarrisFarm Markets → Harrisfarm → `HFM IT QA`), Damien Milthorpe (`department_admin`, **no email/password until an operator sets one**), Raheel Atta (`admin`, manager: Damien), 52 master activities (41 Active / 11 Inactive), 15 pending pipeline rows (TEST labels kept verbatim, flagged `Needs operational confirmation`) and 14 manual exclusions. Re-apply is idempotent; department moves survive re-import; `--rollback <import_batch_id>` reverses an import without touching the organisation or demo data. Full operator guide: [docs/HFM-IMPORT.md](./docs/HFM-IMPORT.md). After the import, provisioning reconciles the separate **HFM2** tenant and links Damien/Raheel's existing identities to their tenant-local copies without changing the HFM rows or issuing credentials.

Demo identities (local only, password `demo1234`) are unchanged — the imported HFM people have **no** passwords.

The login screen opens on the default company with a **company → entity picker**; the sign-in roster is scoped to the selected workspace (demo identities offer one-click fill, imported principals show a `credentials not set` badge, and linked tenant identities offer their HFM account email). Master Setup → **Companies & entities** shows the companies you may access with live counts and lets an administrator switch the default (audited).

### Separate Harrisfarm Markets tenant (HFM2)

A second, deliberately separate company — **Harrisfarm Markets**, code `HFM2` — lives beside `HarrisFarm Markets` (`HFM`). It has its own entity and four departments (QA, Release Management, Test Automation, Data Services). Damien Milthorpe (`department_admin`) and Raheel Atta (`admin`) have tenant-local people rows whose `email` and password are `NULL` and whose `linked_person_id` points at the HFM account; no address is invented and no credential is copied. An authorised HFM login can switch to HFM2 from the header or the login screen.

Master Setup → **Tenant data** previews exactly which HFM rows would be copied (activities, pipeline, releases, defects, capacity and related children), then copies them on an explicit `COPY` confirmation. Each copy is assigned to the target tenant's Raheel Atta, carries `copy_batch_id`, `copied_from_id` and `source_dataset = injected:<HFM id>`, and is labelled **Copied** in the calendar and pipeline. Re-running while a batch is active writes nothing. Deleting a batch requires typing `DELETE`, removes only rows tagged with that batch inside HFM2, and leaves every HFM row unchanged; a fresh copy can then be created.

### Multi-department scope

The header department switcher accepts **one, several or all** authorised departments. Selecting several unions their people and work; an empty selection means every department the role may see. The server validates every submitted department id against the signed-in account's scope, so a hand-edited request cannot widen the view. Company, entity and department cookies are cleared or revalidated whenever the company changes.

### Project names

Activities accept an optional **project name** (`activities.project_name`). It appears above the activity name on calendar chips and in the drawer, in the dashboard's upcoming list, in reporting activity labels, in search, and through the import aliases `Project`, `Project Name` and `Project Title`. Legacy and HFM-imported rows stay blank rather than guessing a project.

Give someone a login with:

```bash
printf 'a-long-password\n' | npm run db:set-password -- --email ratta@harrisfarm.com.au --password-stdin
```

## What is in the app

| Tab | Stable ID | What it does |
| --- | --- | --- |
| Dashboard | `tab.dashboard` | KPIs, progress and capacity by assignee, 4-month capacity trend, AI insights with evidence |
| QA Calendar | `tab.calendar` | Fiscal year → quarter → month grid, holidays, current week, activity drawer, create/edit/actuals |
| FTE Calendar | `tab.fte` | Planned **activity × day** FTE demand with a total per activity and per day, compared against the people available so QA testing resource can be arranged |
| Pipeline | `tab.pipeline` | Combined QA + recording view, eligibility after weekends/holidays/exclusions/QA overlaps, blockers, TEST flags |
| Capacity | `tab.capacity` | Resource × day grid with inline hours, occupied vs productive utilisation, monthly pivot, FTE demand chart |
| Reporting | `tab.reporting` | Bug ledger linked to activities and services, derived status, progress bars, service matrix |
| Releases | `tab.releases` | Release feed, PQU trains with flags, audited go/no-go governance, deployment formula parity |
| Future Enhancements | `tab.enhancements` | Live AI-drafted proposals (every field suggested, always editable), markdown vault in the repo, stage flow, handover documents panel and archive, plus a **two-way GitHub bridge** to any repository |
| Data Quality | `tab.validation` | Rule catalogue + idempotent validation queue + audit trail |
| Import Centre | `tab.imports` | Dry-run reconciliation, idempotent apply, row provenance |
| Master Setup | `tab.setup` | Companies, tenant provisioning/copy batches, departments, drag-and-drop hierarchy, employees, tab/section toggles, holidays, defaults |
| What's New | `tab.changelog` | Release/PR notes recorded in-product, build information |

Every tab and section renders its **stable ID** (`tab.*` / `sec.*`) next to the heading so future requests can name an exact surface. The full catalogue is generated into [`docs/ID-CATALOGUE.md`](./docs/ID-CATALOGUE.md) by `npm run catalogue`.

### AI guidance, everywhere
Each tab and section carries an editable sticky note at the top of the section. Notes are seeded with operational guidance, can be re-drafted from live data ("AI draft"), and are stored with author and timestamp. The AI engine is local and deterministic: no operational data leaves the server (see [DECISIONS #12](./docs/DECISIONS.md)).

### Two-way GitHub bridge (v2)
The Future Enhancements vault and a GitHub repository now run the *same*
backlog. Work can start in either place:

- **Push to GitHub** opens one issue per proposal (labelled
  `future-enhancement` and `status:<stage>`) and updates it afterwards.
- **Pull from GitHub** imports issues carrying the import label as proposals and
  refreshes the ones already linked, including their linked pull requests.
- **Sync both ways** is the default and runs pull *then* push, so an edit made on
  GitHub is never overwritten by an older local copy.

The rules are explicit: progress never moves backwards (the furthest-along stage
wins), `Rejected` is terminal, an issue closed on GitHub archives the proposal,
an archived proposal closes its issue, and a write is only sent when something
actually differs — so the scheduled sync is safe to run unattended. Every run is
journalled in-app and audited.

`sec.enhancements.github` shows the configuration, the linked issues and their
PRs, and the recent runs; `sec.enhancements.portability` lists exactly which
files to copy to reuse the module — the repository is configuration
(`GITHUB_ENHANCEMENTS_REPO`), not code, so one deployment can manage several
projects. Full guide: [docs/ENHANCEMENTS-GITHUB-BRIDGE.md](./docs/ENHANCEMENTS-GITHUB-BRIDGE.md).

```bash
# optional unattended sync (also runs from .github/workflows/enhancement-github-sync.yml)
export APP_URL=https://your-deployment ENHANCEMENT_SYNC_SECRET=...
npm run enhancement:github-sync
```

### Live AI drafting in the enhancement studio
While you type “what needs to change?”, the studio drafts **options** — never a single fixed answer — for the outcome you want, the impacted tab/section IDs, title, brief, requirements, impacts, expected outcome, success criteria and the markdown handover. Each field offers two or three candidates you can accept, re-roll or ignore. The moment you type in a field it becomes yours: suggestions never overwrite an edit, and auto-drafting can be switched off entirely. Which fields were accepted from the assistant is stored on the proposal (`enhancements.ai_fields`) and written into the markdown front matter, so a reviewer can always tell machine-drafted text from the author's own words.

### Organisation, departments and visibility
- Company entity and any number of departments; departments can be **disabled** without deleting data.
- Employees have roles (`viewer`, `editor`, `manager`, `exec`, `admin`) and report into a hierarchy edited by **drag and drop**.
- Visibility is **downward-only**: you see your own sub-tree, never your manager or anyone above. `exec`/`admin` get the holistic view management needs.
- Administrators and execs can preview the app as any employee; preview sessions are read-only and clearly banner-flagged.
- The department switcher in the top bar scopes every operational view.

### Calendar and scheduling rules
- Date-only schedule fields; display timezone `Australia/Sydney`; timestamps stored as ISO.
- Inclusive dates; a schedulable record needs `start <= end`; duration = end − start + 1 calendar days (source parity, not working days).
- Only **Active** activities display, count or block pipeline work.
- FY27 = **July 2026 – June 2027**; quarter selection applies, and a month selection overrides the quarter.
- NSW public holidays are supplied configuration, never fetched or invented.

### Capacity, FTE and progress
- Capacity hours are per person, per day, with four explicit categories: not available, DevOps, recording/maintenance, QA testing.
- **Occupied capacity** = unavailable + DevOps + recording + QA ÷ total hours. This is not productive utilisation, and it is deliberately separate from FTE demand.
- The **FTE calendar** (`tab.fte`) answers a different question: *which testing activity needs how much FTE on which day, and can we cover it?* One row per activity, one column per day, a total per row and per column, plus a demand-per-day chart against the headcount available. Scope it by month or fiscal quarter, department, activity group or assignee, and switch between FTE and hours. Supply is headcount × working days less recorded leave and DevOps time; a negative gap is a request for people, not a performance signal ([DECISIONS #22](./docs/DECISIONS.md)).
- FTE precedence: explicit per-record override → Regression default `1` → stored FTE → configured default `0.5`. Hours convert through a configurable day length (7.6 default, 8 available) — 4h = 0.5 FTE at 8h/day.
- **Releases are QA demand too**: a release has an inclusive QA window (from/to) and any number of assignees with a per-working-day FTE share. FTE-days = Σ shares × working days (Mon–Fri less NSW holidays), and the same rows appear in the Releases tab, the QA calendar (REL chips) and the FTE calendar (a `Release` group with its own daily column contribution). A window with no assignees is shown as `Unassigned` with 0 FTE and a validation warning — never guessed.
- Completion is derived from linked bugs: closed = 100%, fixed = 75%, open = 0%. A manual snapshot overrides the derived figure and is kept with its date.
- A bug shared by two services closes only when **every** service link is closed.

### Pipeline rules
- Effective window uses the later planned/actual start and the later planned/actual end.
- Eligibility = weekdays − NSW holidays − manual exclusions − days blocked by an Active QA activity overlap.
- Inactive QA never blocks. TEST rows are flagged and excluded from operational KPIs.
- Every exclusion needs a reason and is written to the audit log.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server on `0.0.0.0:3000` |
| `npm run build` / `npm start` | Production build and serve |
| `npm run db:migrate` | Apply pending SQL migrations from `db/migrations` |
| `npm run db:seed` | Seed reference config + demo data (idempotent) |
| `npm run db:reset` | **Destructive** local reset |
| `npm run db:backup` | Online SQLite backup with SHA-256 checksum |
| `npm run import -- <file.csv> [--target activities\|pipeline] [--apply]` | Import CLI, dry-run by default |
| `npm run db:embed` | Regenerate `db/migrations.generated.ts` (run after editing `db/migrations`) |
| `npm test` | Unit, integration and live-driver tests (142 tests) |
| `npm run typecheck` | Strict TypeScript check |
| `npm run catalogue` | Regenerate `docs/ID-CATALOGUE.md` |

## Project layout

```
app/                 Next.js App Router (pages, server actions, API route)
  (app)/             Authenticated shell pages
  actions/           Server actions (validated, audited writes)
components/          Client + server UI primitives
lib/                 Domain logic: dates, capacity, pipeline, release FTE, access, AI, import, validation
lib/database/        Driver facade: SQLite (node:sqlite), Postgres (pg + worker bridge), SQL dialect, generated PG schema
db/migrations/       001…007 SQL migrations (40 tables, tenancy, provenance, audit, release planning, note scoping)
scripts/             migrate, seed, reset, backup, import CLI, catalogue, automation
.github/workflows/   CI, handover intake, PR coordination, merge completion
tests/               node:test unit + integration + automation suites
docs/                feature map, ERD, decisions, deployment, test results, ID catalogue
enhancements/        Markdown vault for future enhancement proposals
lib/future-enhancements/ Approved Building handovers and archived completions
data/                Local SQLite database (gitignored) + sample import file
```

## Documentation

- [Feature map: source sheet → target](./docs/FEATURE-MAP.md)
- [ERD and data model](./docs/ERD.md)
- [Decisions, defaults and open questions](./docs/DECISIONS.md)
- [Deployment, security and recovery](./docs/DEPLOYMENT.md)
- [Acceptance tests and results](./docs/TEST-RESULTS.md)
- [Stable tab/section IDs](./docs/ID-CATALOGUE.md)

## Limitations and honesty notes

- The source workbook is **not** in this repository. Imports are therefore exercised against a representative sample (`data/sample-activities.csv`); the mapping layer accepts the documented headers, including the source typo `Assing To`.
- Authentication is a local scrypt/password + signed-cookie implementation so the app runs without external services. Replace with your approved identity provider before production ([DEPLOYMENT](./docs/DEPLOYMENT.md)).
- Demo data is synthetic and flagged `is_demo`; it is never presented as operational evidence.
- Postgres is supported in-app (`DATABASE_URL`), but **this repository's CI never touches a real Postgres server**: the driver is exercised against PGlite over the Postgres wire protocol (`tests/postgres-driver.test.mts`). Treat a first production deployment as a dress rehearsal: run `npm run db:migrate`, open `/api/health` and reconcile the counts.
- On serverless hosting (Vercel) **without** `DATABASE_URL` the app runs in demo mode: SQLite lives on the instance's `/tmp`, the UI shows a "Serverless demo instance" banner, and data resets when the function restarts. With `DATABASE_URL` set there is no banner and no reset — see [DEPLOYMENT §3](./docs/DEPLOYMENT.md#3-serverless-deployment-vercel). `GET /api/health` reports the active driver, path/target, migrations and seed counts.
- Where the source behaviour is ambiguous (overlap-parity, display consolidation, multi-assignee shares) the app keeps the safer default and records the open question in [DECISIONS](./docs/DECISIONS.md).

### Approved enhancement handovers

Moving a proposal to **Building** publishes its Markdown to
`lib/future-enhancements/` using `GITHUB_REPO` and a server-side `GITHUB_TOKEN`
with contents read/write permission. The transition fails visibly if publishing
fails; branch protection must allow the configured token to write the target
branch (`GITHUB_ENHANCEMENTS_BRANCH`, default `main`).

A push that adds an `ENH-*.md` handover now creates one durable
`arena-handover` development request with a ready-to-paste Arena.ai Agent Mode
prompt. Arena Agent Mode is user-initiated, so the issue is a reliable handoff
to a new Arena coding session; it cannot start that session itself. No paid
GitHub Copilot cloud agent, GitHub Models inference or external LLM token is
used. PRs are linked to their request, gated by the `Build and test` check,
squash-merged after that exact head SHA passes, then completed by marking the
handover **Built**, archiving it into `lib/future-enhancements/archived/`,
closing the issue and cleaning up branches within the configured scope. The
completion workflow also runs after the CI-gated merge itself, because a merge
performed with a workflow token emits no `pull_request` closed event. The app
reconciles its request statuses from the committed documents (Building → Built →
Archived) on bootstrap and via `npm run enhancement:sync`, so the Markdown record
and the in-app status never disagree; `sec.enhancements.handovers` shows both
side by side. A protected `main` can be
handled through a generated CI-gated archive PR instead of a direct push.
Unrelated branches are preserved, and active Arena session branches
(`arena/<session-id>`) are never deleted automatically. The default allowlist
covers `copilot/`, `enh/`, `enhancement/`, `automation/` and `arena/` so merged
session head branches are cleaned up without manual work;
`CLEANUP_ALL_MERGED_BRANCHES` is an explicit opt-in for broader cleanup.
Vercel runtime variables are documented in
[automation setup](docs/ENHANCEMENT-AUTOMATION.md); GitHub Actions
variables/secrets are configured separately in GitHub. The Git-side workflow
does not sync the in-app SQLite status.

The download button uses the Markdown already rendered on the authenticated page,
so it does not navigate through a separate serverless instance. This does not
make SQLite durable: on serverless deployments accounts, sessions and
proposals can still disappear or differ between instances. `DATABASE_URL` is
not implemented by this application; a shared durable database adapter is needed
for reliable production login and proposal state.
