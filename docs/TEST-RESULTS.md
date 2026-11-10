# Acceptance tests & results

Run with `npm test` (Node's built-in test runner via `tsx`). The integration suite runs against an isolated temporary database, so it never touches your working data.

**Last run:** 10 Nov 2026 · Node 22.22 · `142 tests, 142 pass, 0 fail` · `npm run typecheck` clean · `npm run build` succeeded · HFM acceptance verification `23 passed, 0 failed` on the local demo database.

## Automated suites

| # | Test | Requirement covered |
| --- | --- | --- |
| 1 | database seeds reference configuration and demo data | Migrations + reference seeding (tabs, sections, notes, holidays, activities) |
| 2 | management view sees more than an individual contributor | Downward-only visibility; holistic role sees the organisation |
| 3 | import dry run changes nothing and apply is idempotent | Dry-run reconciliation, idempotent apply, provenance |
| 4 | spreadsheet serial dates and unknown dates are handled explicitly | Excel date system, textual dates, unknown stays unknown |
| 5 | invalid ranges are flagged, never corrected | Inclusive date validation |
| 6 | shared defect stays open until every service link is closed | One bug ID across two services; one outstanding link keeps it open |
| 7 | validation detects governance and range problems | Go without regression, invalid ranges, unscheduled queue |
| 8 | demo bugs expose reported/fixed/closed/outstanding totals | Defect ledger KPIs |
| 9 | national holidays feed working-day logic | NSW holidays as configuration |
| 10 | hierarchy move cannot create a loop | Drag-and-drop restructuring guard |
| 11 | FY27 runs July 2026 to June 2027 | Fiscal year labels and boundaries |
| 12 | quarters are ordered Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun | Fiscal quarter selection |
| 13 | dates are inclusive and ranges are validated | Date-only schedule fields |
| 14 | month grid starts on Monday and excludes weekends/holidays from working days | Calendar rendering + holiday/weekend behaviour |
| 15 | FTE defaults follow Regression=1, otherwise 0.5, with explicit override winning | FTE rules and precedence |
| 16 | hours convert to FTE without inventing an 8-hour default | 4h = 0.5 at 8h/day; 7.6h default preserved |
| 17 | pipeline duration uses the later planned/actual start and later end | Source pipeline formula parity |
| 18 | shared bug stays open while any service link is outstanding | Derived status rule |
| 19 | deployment plan reproduces `start + weeks*6` then workday adjustment | WORKDAY.INTL parity |
| 20 | visibility is downward-only and excludes disabled departments | Access rules |
| 21 | AI enhancement draft is structured and deterministic | Enhancement intake |
| 22 | eachDay never loops past a reversed range | Date helper safety |
| 23 | every tab and section carries an AI guidance note | AI sticky note coverage (no section left without guidance) |
| 24 | catalogue covers every tab and section with a stable ID | Stable `tab.*` / `sec.*` identifiers |
| 25 | session tokens are signed, self-contained and tamper-evident | Serverless sessions; tampered/legacy cookies rejected |
| 26 | migrations are embedded for serverless bundles | Build-time `db:embed` keeps schema available on a read-only filesystem |
| 27 | FTE is demanded on every inclusive day of an activity and nowhere else | FTE calendar cell rule |
| 28 | overlapping activities sum per day rather than averaging | FTE calendar daily totals |
| 29 | headcount needed is whole people, never fractions of a person | FTE calendar resourcing arithmetic |
| 30 | fiscal quarters start in July and end on the last day of the quarter | FTE calendar quarter scope |
| 31 | FTE calendar days distinguish weekends and supplied holidays | Working-day totals exclude non-working days |
| 32 | the studio drafts options for every field, not a single fixed answer | Live enhancement suggestions |
| 33 | impact suggestions rank real tab and section IDs against the request | Suggested IDs always exist in the catalogue |
| 34 | the handover keeps every section heading and never invents an ID | Markdown handover draft |
| 35 | FTE calendar totals reconcile across rows, days and the rollups | Row/day/assignee/group totals agree |
| 36 | FTE calendar scopes by department, group and quarter | Filters + visibility rules |
| 37 | recording rows are excluded from the testing-only FTE calendar | Testing-activity filter |
| 38 | ephemeral serverless enhancement vault lists seeded and newly submitted proposals | Serverless `/tmp` enhancement vault + DB listing |
| 39 | enhancement vault falls back cleanly to `/tmp` when the configured or bundle path is read-only | `EROFS`/`EACCES` fallback on submit, archive and delete |
| 40 | `readEnhancementMarkdown` synthesises frontmatter Markdown when no disk copy exists | Cross-instance `/api/enhancements/:id` download resilience |
| 41 | the status flow keeps Building/Built published and archives exactly once | `Building → Built → Archived` transitions never overwrite a rejection |
| 42 | document scan distinguishes the archived tree from the active tree | `lib/future-enhancements/` vs `archived/` (legacy `archive/` included) |
| 43 | mark-handovers-built promotes only resolved Building documents | Handover status is written from a verified merge, not a guess |
| 44 | the archive step accepts Built handovers and refuses anything else | Completion archives Building/Built only; Rejected is never swept |
| 45 | the deploy sync is a no-op when the build ships no handover documents | Serverless deployments never pay for a sync they cannot use |
| 46 | the deploy sync honours the opt-out flag | `ENHANCEMENT_DOC_SYNC=false` disables the bootstrap reconciliation |
| 47 | an archived handover document moves the matching request to Archived | File move drives in-app status; idempotent on re-run |
| 48 | a Built document is reported without archiving the request | Built is an intermediate state, not an archive |
| 49 | merged PR resolution writes authoritative archive and issue files | Completion resolves the linked `arena-handover` request |
| 50 | build verification requires a successful latest Build and test check | Exact-head-SHA gate (also verifiable from `PR_NUMBER`) |
| 51 | all workflow YAML parses and the CI gate is wired into completion | Completion also runs on the CI-gated merge `workflow_run` |
| 52 | completion resolution fetches the merged PR when the event carries none | `workflow_run` / manual repair path resolves the merged PR and its linked request |
| 53 | HFM payload matches embedded expected counts before any write | Source-snapshot checksum guard |
| 54 | HFM dry-run validates without writing anything | Default mode is non-destructive |
| 55 | HFM apply commits 52/15/14 in one transaction with a batch ID | Import atomicity + provenance |
| 56 | HFM re-apply is fully idempotent | No duplicates on refresh |
| 57 | a manually re-parented department survives re-import | Conflict recorded, never overwritten |
| 58 | HFM acceptance verification passes every check | 23-check `verifyHfmImport()` |
| 59 | source fidelity: literal IDs, fractions, raw text, NULL preservation | QA-008 / QA-00013 / TEST-001 0.55 / TEST-009 NULL / `&amp;` raw |
| 60 | TEST-labelled records preserved, flagged for owner confirmation | `is_test`, `source_test_label`, `verification_status` |
| 61 | unresolved assignee labels flagged, never silently matched | `activity.assignment_review`; no invented people |
| 62 | pipeline `needs_confirmation` reported as info, never error | Rule catalogue severity |
| 63 | effective duration subtracts union of auto overlaps + manual exclusions | Weekday arithmetic; union dedup; holiday gate; incomplete range → NULL |
| 64 | department-scoped administrators isolated to their own department | `scopeFor` / `canAdminDepartment` / `canManageDepartment` |
| 65 | rollback removes only imported snapshot; org + demo data survive | Rollback scoping |
| 66 | companies list shows both tenants, HFM company defaults and sorts first | Multi-tenant visibility |
| 67 | entities listed per company; demo tenant reports none | Entity roll-up counts |
| 68 | default login scope lists only the default company's people; imported principals flagged credential-less | Login roster scoping; nothing invented |
| 69 | entity-scoped login lists exactly the entity roster | Entity picker |
| 70 | demo tenant scope lists demo identities plus the department-less exec | Dept-less attach to oldest company |
| 71 | setDefaultCompany flips the flag atomically, audits settings, rejects unknown ids | `company.set_default` administration |
| 72 | unknown company/entity params fall back safely; foreign entity cannot be forced | Scope fallback rules |

Full test output (abridged):

```
# tests 95
# pass 95
# fail 0
# duration_ms 5169
```

## Manual verification performed

| Check | Method | Result |
| --- | --- | --- |
| Login page renders demo identities | `GET /login` | 200, 8 accounts listed |
| Authenticated shell + dashboard | session cookie as admin | 200, KPIs + insights render |
| Calendar fiscal selectors and grid | `GET /calendar?fy=FY27&q=2&month=2026-11` | 200, month grid, holidays, legend |
| Capacity planner + pivot | `GET /capacity` | 200, grid + monthly pivot + FTE chart |
| Pipeline with exclusions | `GET /pipeline` | 200, eligibility, TEST flags, exclusion table |
| Reporting + derived status | `GET /reporting` | 200, shared defect shows per-service links |
| Releases / PQU / governance | `GET /releases` | 200, flagged train, deployment parity table |
| FTE calendar | `GET /fte`, `/fte?range=quarter`, `/fte?group=Regression`, `/fte?testing=0`, `/fte?q=regression` | 200 on every scope; matrix, totals row, KPIs and resource rollup render |
| Enhancements studio | `GET /enhancements` | 200, live AI options + vault |
| Data quality queue | `GET /validation` | 200, rules + issues + audit |
| Import dry-run + apply + re-apply | CLI | 4 inserted → 4 skipped (idempotent) |
| Viewer (read-only) access to all operational tabs | session as `hana.suzuki` | 200 on dashboard, calendar, capacity, pipeline, reporting, releases, enhancements, changelog |
| Production build | `npm run build` | Compiled successfully, 14 routes |
| Type safety | `npm run typecheck` | No errors |
| HFM dry-run on the dev database | `npm run db:hfm-import` | No errors; 14 warnings (source artifacts), writes nothing |
| HFM apply + verify on the dev database | `npm run db:hfm-import -- --apply` then `--verify` | 52/15/14 committed; `23 passed, 0 failed`; pre-apply backup in `data/backups/` |
| HFM organisation after import | `loadOrg()` + scope inspection | Damien `department_admin` scoped to HFM IT QA (email NULL); Raheel `admin` reporting to Damien |
| Login scope (default/entity/demo/other) | Browser + scoped roster queries | Default opens on HarrisFarm Markets (Damien + Raheel, credential-less badge); entity URL lists only the entity; demo tenant shows 12 demo identities; cross-tenant entity rejected |
| Master Setup companies & entities block | `GET /setup` as admin | Both companies with aliases/counts, entity sub-row (Harrisfarm: 1 dept, 2 people), audited Make-default button |
| Serverless simulation (`VERCEL=1`, fresh `/tmp`) | `next start` + `/api/health` | 200: schema 35 tables, seed 12 people, `ephemeral: true` |
| Read-only configured DB path (`DATABASE_FILE=/sys/qa/calendar.db`) | `next start` + `/api/health` | Warns, falls back to `/tmp/qa-calendar.db`, pages 200 |
| Stateless session across instances | signed cookie with no `sessions` row | Dashboard 200; tampered cookie and no cookie both 307 → `/login` |

## Acceptance criteria from the handover

| Criterion | Status | Evidence |
| --- | --- | --- |
| All 26 source sheets have an explicit disposition | **17 mapped, 9 recorded as pending** | [FEATURE-MAP](./FEATURE-MAP.md) — workbook not supplied |
| Active toggles across calendars / FTE / blocking | Done | `active` filter in every query; tests 1, 3, 20 |
| Inclusive dates and holiday/weekend behaviour | Done | Tests 13, 14, 19 |
| FY27 and month-over-quarter filters | Done | Tests 11, 12; calendar selectors |
| Regression FTE 1 and 4h/8h = 0.5 | Done | Tests 15, 16 |
| Actual resource capacity (7.6/4, not universal 8) | Done | Capacity grid; `capacity.assumed_eight_hours` info rule |
| Manual pipeline exclusions | Done | Exclusions table, audited reason, eligibility test data |
| Shared bug ID once overall / twice across two services | Done | Tests 6, 18; Reporting → Service matrix |
| One outstanding link keeps a bug open | Done | `deriveStatus` + seeded `HFM-1051` |
| Samples / inactive excluded | Done | `is_demo` and `active` filters; TEST badges |
| Unknown timestamps never invented | Done | `parseSourceDate` → null + warning; test 4 |
| Archived narrative notes preserved | Done | `original_notes_archive`; import warns on long narrative |
| No secret leakage | Done | `.env.example` only; no env rendered in UI |
| Idempotent import and validation recovery | Done | Test 3; validation upsert by `(entity, id, rule)` |

## Postgres driver and release planning (1.6.0)

| # | Test | Requirement covered |
| --- | --- | --- |
| P1 | SQL translation for Postgres | `?` → `$n`, `datetime('now')`, `LIKE` → `ILIKE`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `IS ?` → `IS NOT DISTINCT FROM ?`, `PRAGMA` dropped, hard error on `sqlite_master`/`rowid`/`INSERT OR REPLACE` |
| P2 | Postgres schema generation | All 40 tables, 41 foreign keys and indices emitted in dependency order from the replayed migrations |
| P3 | Baseline ledger | `pg-baseline@005_release_planning.sql` recorded once; a second `migrate()` is a no-op |
| P4 | Live driver over the Postgres wire protocol | PGlite in a child process: worker start-up, ping, DDL, inserts, `LIKE`, constraint violation surfaced, commit and rollback, null-safe `IS ?`, `tableCount()` |
| R1 | Release QA window maths | Inclusive window, working days = Mon–Fri less NSW holidays (2030-03-04 → 2030-03-15 = 10 working days) |
| R2 | Release FTE-days and hours | Σ assignee shares (0.6 + 0.4) × 10 working days = 10 FTE-days = 76 h at 7.6 h/day |
| R3 | Unassigned window | Gap row named `Unassigned`, 0 FTE + `release.qa_window_unassigned` warning |
| R4 | Validation | `release.qa_window_missing` (info), `release.qa_window_invalid` (error), `release.qa_window_after_release` |
| R5 | Calendar integration | `REL` chips across the window service-side; FTE calendar `totals.releases`, `release_fte_days`, +1.0 FTE on a day with 0.6 + 0.4, `group: "Release"` filter |
| R6 | Assignable people | Disabled departments and inactive people are excluded from the picker |
| R7 | Cascade delete | Deleting a release (or a person) removes its `release_assignees` rows |

**Measured end to end on Postgres 16 (PGlite socket server, `PG_POOL_MAX=1`):**
baseline applied once → `people 12`, `activities 20`, `releases 6`,
`release_assignees 8`, `plans 6`, `fte rows 10`, `release rows 3`,
`release FTE-days 7.5`, transaction rollback effective, `tableCount 41`.

## Gaps / next verification (needs the workbook)

1. Formula-level comparison of Master Calendar and Master Calendar (2).
2. Overlap exemption parity for matching Activity/Detail names.
3. Confirmation of the hours→FTE divisor used in reporting.
4. Multi-assignee allocation shares.
5. Hidden sheets, named ranges and pivots — enumerate after the workbook is supplied.

Each gap has a safe default documented in [DECISIONS](./DECISIONS.md).
