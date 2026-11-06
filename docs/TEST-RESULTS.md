# Acceptance tests & results

Run with `npm test` (Node's built-in test runner via `tsx`). The integration suite runs against an isolated temporary database, so it never touches your working data.

**Last run:** 7 Nov 2026 · Node 22.22.3 · `37 tests, 37 pass, 0 fail` · `npm run typecheck` clean · `npm run build` succeeded.

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

Full test output (abridged):

```
# tests 37
# pass 37
# fail 0
# duration_ms 1180
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

## Gaps / next verification (needs the workbook)

1. Formula-level comparison of Master Calendar and Master Calendar (2).
2. Overlap exemption parity for matching Activity/Detail names.
3. Confirmation of the hours→FTE divisor used in reporting.
4. Multi-assignee allocation shares.
5. Hidden sheets, named ranges and pivots — enumerate after the workbook is supplied.

Each gap has a safe default documented in [DECISIONS](./DECISIONS.md).
