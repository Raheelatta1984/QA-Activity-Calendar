# HFM QA Activity Calendar

An AI-assisted QA operations workspace that replaces the HFM QA activity workbook: activities, recording pipeline, capacity, releases and defect reporting in one persistent, role-aware application.

Built to the handover in [`ReadTheProjectMDfile.md`](./ReadTheProjectMDfile.md). It is a **working application**, not a prototype: real database, migrations, import tooling, tests and deployment notes. The legacy workbook is never modified — data is imported as text with full provenance.

```bash
npm install
cp .env.example .env            # optional for local dev; defaults are safe
npm run db:migrate && npm run db:seed
npm run dev                     # http://localhost:3000
```

Demo identities all use the password `demo1234`:

| Person | Email | Role | Sees |
| --- | --- | --- | --- |
| Amara Okafor | `amara.okafor@hfm.demo` | admin | everything |
| Lachlan Reid | `lachlan.reid@hfm.demo` | manager | QA team sub-tree |
| Sofia Marchetti | `sofia.marchetti@hfm.demo` | editor | own work only |
| Hana Suzuki | `hana.suzuki@hfm.demo` | viewer | own work only |
| Priya Raman | `priya.raman@hfm.demo` | exec | holistic, read-mostly |

---

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
| Future Enhancements | `tab.enhancements` | Live AI-drafted proposals (every field suggested, always editable), markdown vault in the repo, stage flow, archive |
| Data Quality | `tab.validation` | Rule catalogue + idempotent validation queue + audit trail |
| Import Centre | `tab.imports` | Dry-run reconciliation, idempotent apply, row provenance |
| Master Setup | `tab.setup` | Company, departments, drag-and-drop hierarchy, employees, tab/section toggles, holidays, defaults |
| What's New | `tab.changelog` | Release/PR notes recorded in-product, build information |

Every tab and section renders its **stable ID** (`tab.*` / `sec.*`) next to the heading so future requests can name an exact surface. The full catalogue is generated into [`docs/ID-CATALOGUE.md`](./docs/ID-CATALOGUE.md) by `npm run catalogue`.

### AI guidance, everywhere
Each tab and section carries an editable sticky note at the top of the section. Notes are seeded with operational guidance, can be re-drafted from live data ("AI draft"), and are stored with author and timestamp. The AI engine is local and deterministic: no operational data leaves the server (see [DECISIONS #12](./docs/DECISIONS.md)).

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
| `npm test` | Unit + integration tests (37 tests) |
| `npm run typecheck` | Strict TypeScript check |
| `npm run catalogue` | Regenerate `docs/ID-CATALOGUE.md` |

## Project layout

```
app/                 Next.js App Router (pages, server actions, API route)
  (app)/             Authenticated shell pages
  actions/           Server actions (validated, audited writes)
components/          Client + server UI primitives
lib/                 Domain logic: dates, capacity, pipeline, access, AI, import, validation
db/migrations/       001_init.sql (30+ tables, provenance, audit)
scripts/             migrate, seed, reset, backup, import CLI, catalogue
tests/               node:test unit + integration suites
docs/                feature map, ERD, decisions, deployment, test results, ID catalogue
enhancements/        Markdown vault for future enhancement proposals
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
- On serverless hosting (Vercel) the app runs in **demo mode**: SQLite lives on the instance's `/tmp`, the UI shows a "Serverless demo instance" banner, and data resets when the function restarts. Durable storage requires Postgres — see [DEPLOYMENT §3](./docs/DEPLOYMENT.md#3-serverless-deployment-vercel). `GET /api/health` reports the active database path, migrations and seed counts.
- Where the source behaviour is ambiguous (overlap-parity, display consolidation, multi-assignee shares) the app keeps the safer default and records the open question in [DECISIONS](./docs/DECISIONS.md).
