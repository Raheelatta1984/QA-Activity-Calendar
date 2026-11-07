# Source → target feature map

**Source of truth:** `ReadTheProjectMDfile.md` (the handover prompt, prepared 6-Nov-2026). The workbook itself is **not** present in this repository, so formula-level inspection is represented by the mapping contract below and exercised through the import layer.

Disposition legend:

| Code | Meaning |
| --- | --- |
| **Imported** | Rows are imported verbatim with provenance (`source_sheet`, `source_row`, `import_batch_id`). |
| **Rebuilt** | Behaviour re-implemented as query logic (no cached grid). |
| **Config** | Values become editable configuration instead of sheet cells. |
| **Derived** | Computed on demand from live records. |
| **Legacy** | Preserved as archive/reference; not converted into invented records. |
| **Pending** | Sheet was not supplied; explicit disposition still recorded. |

## Named sheets (17 of 26)

| # | Source sheet | Target | Disposition | Notes / parity |
| --- | --- | --- | --- | --- |
| 01 | Copilot Prompt | Sticky notes + `docs/DECISIONS.md` | **Config** | Read as data, never executed. Guidance is mapped to editable sticky notes on every tab/section. |
| 02 | Master Activity Data (`tblActivities`) | `activities`, `activity_assignments` | **Imported** | Column mapping below. Blank template rows vs genuine unscheduled records separated; `Assing To` spelling preserved in the import alias list, normalised internally to `assignee_id`. |
| 11 | Res_Alloc_Projection | Capacity → FTE demand (`demandByDay`) + `tab.fte` (FTE calendar by activity) | **Rebuilt** | Daily FTE total computed over inclusive dates; activity rows stay a breakdown, not people. Future dates supported; person filter via scope; over-allocation flagged (`activity.fte_conflict`, `>1 FTE`). |
| 12 | Master Calendar | QA Calendar | **Rebuilt (partial)** | Annual grid virtualised to month windows. Sheet not supplied for formula comparison → **no consolidation** with Master Calendar (2); see DECISIONS #10. |
| 13 | Master Calendar (2) | QA Calendar | **Rebuilt** | 1,281-column grid replaced by a date-window query + month rendering; no precomputed empty cells. |
| 14 | QA Calendar | `tab.calendar` | **Rebuilt** | Year → quarter → month selection; holidays, weekends, today, current week. Activity opens from the calendar item. Display-rule consolidation is pending confirmation (DECISIONS #11). |
| 15 | QA + Pipeline Calendar | `tab.pipeline` + calendar view filter | **Rebuilt** | QA and pipeline labels remain separate; priority overlap suppression implemented as Active-QA block; month selection overrides quarter. |
| 16 | Pending Recordings Pipeline (`tblRecordingPipeline`) | `recording_pipeline`, `pipeline_exclusions` | **Imported** | Planned/actual dates, recording status, current status, automation %, blocker, colour, manual exclusions with reasons. TEST records flagged. |
| 17 | Pipline Recordings | `original_notes_archive` | **Legacy** | Original spelling kept. Free-text progress notes archived verbatim, never converted into dated records. |
| 18 | Pipeline Progress | `tab.pipeline` KPIs + availability windows | **Derived** | Daily availability, progress, blockers and KPI rollups from pipeline + exclusions + QA + holidays; no materialised cells. |
| 19 | Release Feed | `release_feed` | **Imported** | Version strings and date-only values preserved; links stored but never auto-fetched; human "verified" flag. |
| 20 | PQU Schedule | `pqu_trains` | **Imported** | Raw text kept alongside parsed cutoff/duration; suspicious chronology produces a flag, never a silent correction. |
| 21 | Capacity Planner | `resource_day_capacity`, `tab.capacity` | **Imported + Rebuilt** | Four hour categories; 7.6 and 4-hour days preserved; monthly/resource pivots computed on demand. |
| 22 | Release Governance | `release_governance` | **Imported + Rebuilt** | Audited decision flow; a planned status is never treated as approval; Go requires regression Passed. |
| 23 | Calendar Control | `tab.setup`, `colour_rules`, `validation_issues` | **Config** | Overlap diagnostics, colour dictionary, IDs and selectors are configuration/control views. Missing dates, invalid ranges, duplicates and conflicts surface in Data Quality. |
| 24 | NSW Public Holidays | `holidays` | **Config** | Supplied dates/names only; no fetching or invention. Feeds working-day logic, FTE projection and pipeline eligibility. |
| 25 | Dashboard Data | `tab.dashboard` + selector logic | **Derived** | Selected-month helper re-implemented as calendar selector logic; FY27 = Jul 2026–Jun 2027; quarter/month precedence enforced. |

## Remaining sheets (9 of 26) — explicit disposition

The prompt references "all 26 source sheets" but only the 17 above are named. The missing indices (03–10 and 26) are **not available** in this repository.

| # | Sheet | Disposition | Required action |
| --- | --- | --- | --- |
| 03 | *not supplied* | **Pending** | Import with workbook attached; classify as data/config/ignore. |
| 04 | *not supplied* | **Pending** | Same. |
| 05 | *not supplied* | **Pending** | Same. |
| 06 | *not supplied* | **Pending** | Same. |
| 07 | *not supplied* | **Pending** | Same. |
| 08 | *not supplied* | **Pending** | Same. |
| 09 | *not supplied* | **Pending** | Same. |
| 10 | *not supplied* | **Pending** | Same. |
| 26 | *not supplied* | **Pending** | Same. |

Hidden sheets, named ranges, pivots and conditional formatting cannot be enumerated without the file. When the workbook is supplied, run the import CLI dry-run and complete this table before go-live; the workbook must remain unmodified.

## `tblActivities` column mapping

| Source header (spelling preserved) | Internal field | Transformation |
| --- | --- | --- |
| Activity | `activity` | Trimmed; required |
| Activity Detail | `detail` | Trimmed |
| Activity Group | `activity_group` | Drives default FTE and colour |
| Rule Type | `rule_type` | Preserved |
| Active Status | `active` | `Yes/Y/TRUE/Active/1` → 1, otherwise 0 |
| Start Date | `start_date`, `planned_start` | ISO; Excel serial and day/month/year text parsed and reported |
| End Date | `end_date`, `planned_end` | ISO; inclusive |
| Duration | `duration_days` | Recomputed as end − start + 1; source cached values not trusted blindly |
| FTE | `fte` | Numeric; 0/blank falls back to the group default |
| Colour | `colour` | Preserved hex |
| Assing To | `assignee_id` | Resolved by name/email; unknown → Unassigned + warning |
| Status | `status` | Preserved |
| Notes | `notes` | Preserved; long narrative also archived |
| Data Quality | `data_quality` | Preserved + shown in Data Quality |
| Calendar Item ID | `code`, `calendar_item_id` | Natural key for idempotent import |

## Non-functional requirements coverage

| Requirement | Where |
| --- | --- |
| Persistent storage + migrations | `db/migrations/001_init.sql`, `lib/db.ts` |
| Server-side API / actions | `app/actions/*` (validated, audited) |
| Role-based permissions | `lib/access.ts`, role gates on tabs/actions |
| Date-only schedules, Sydney display | `lib/dates.ts`, `APP_TIMEZONE` |
| Secrets in env, no leakage | `.env.example`, `.gitignore` |
| Idempotent import + dry run | `lib/import.ts`, `scripts/import.ts`, Import Centre |
| Row provenance | `source_sheet`, `source_row`, `import_batch_id` |
| Audit trail | `audit_events` written by every mutating action |
| Accessible responsive UI | Semantic landmarks, focus styles, mobile layout, reduced-motion-safe transitions |
| Editable vs calculated clarity | Labels state "derived" where relevant; calculated fields are read-only |
| No empty placeholder modules | Every tab renders live data or an explicit empty state |
| FTE calendar by activity per day with totals | `tab.fte`, `lib/fte.ts`, `components/FteCalendarBoard.tsx` |
| Live AI drafting of enhancement fields | `lib/ai.ts` (`suggestEnhancementFields`), `app/actions/enhancements.ts`, `components/EnhancementStudio.tsx` |
| Enhancement intake → GitHub | `tab.enhancements`, markdown vault, archive flow |
| Handover lifecycle Building → Built → Archived | `sec.enhancements.handovers`, `lib/enhancement-status.ts`, `lib/enhancement-docs.ts`, completion workflow |
| What's New per PR/merge | `tab.changelog` + admin entry form |
