# Changelog

All notable changes to this project are recorded here and, for in-app users, in the **What's new** tab (`/changelog`, backed by the `changelog` table). Format: version — date — summary.

## 1.4.1 — 2026-11-09 — Entity-aware login and full company visibility

- **Login screen**: opens on the default company with a company → entity picker; the sign-in roster is scoped to the selected workspace. Demo identities offer one-click fill (`demo1234`); imported principals are listed with a `credentials not set` badge until an administrator sets a password — nothing is invented.
- **Master Setup → Companies & entities** (`sec.setup.company`, stable ID unchanged): every company shown with aliases, code, default badge and entity/department/people/activity counts, entities listed beneath; admins can switch the default company (audited `company.set_default`). Departments table gains an **Entity** column.
- Department-less people remain discoverable in the oldest company only; unknown company/entity params fall back safely; the default never grants cross-company access.
- New `lib/org.ts` shared by login and setup; `tests/org.test.mts` (7 cases) — **95 tests total**, typecheck and build clean.

## 1.4.0 — 2026-11-09 — HFM source snapshot imported and reconciled

The HarrisFarm Markets QA workbook snapshot (extract 2026-11-09) is now seeded and verified end to end.

- **Organisation**: HarrisFarm Markets (`code HFM`, default company) → Harrisfarm entity → `HFM IT QA` department. Damien Milthorpe seeded as department-scoped administrator (`role_scope_department_id` → HFM IT QA, email/password deliberately NULL). Raheel Atta seeded as application administrator (`admin`), manager link to Damien, resolved only by the supplied email.
- **Migration 003**: additive provenance columns on `activities` (`external_source_id`, `source_dataset`, `source_row`, `source_order`, `source_duration_days`, `effective_duration_days`, `source_assignee_text`, `colour_label`, `source_active_status`, `source_status_raw`, `source_data_quality`, `company_id`); `recording_pipeline` rebuilt with genuinely nullable `recording_status` / `current_status` / `automation_percent`, canonical `automation_fraction`, `source_test_label`, `verification_status`, `excluded_priority_work_dates`, `activity_group`, `applications_raw`, `data_quality_warning`, `overlap_warning`; `people` rebuilt for an optional, unique-when-present `email` and `role_scope_department_id`; unique index on `(company_id, source_dataset, external_source_id)` for both datasets; partial unique index so only one default company exists.
- **Master activities**: 52 imported (41 Active / 11 Inactive). Literal Calendar Item IDs preserved; raw `&amp;` text, notes, colour labels and source order preserved byte-for-byte; missing start/end stay NULL (QA-0052 has no start); `Duration 0` with a missing end stays `source_duration_days = 0` with effective duration NULL.
- **Pending pipeline**: 15 rows, TEST labels verbatim (`is_test`, `source_test_label`, `verification_status = 'Needs operational confirmation'`). TEST-001 automation = 0.55 fraction; TEST-009 automation = NULL. Source `Duration Days` retained in `source_duration_days`.
- **Manual exclusions**: 14 imported, linked to pipeline rows where the reference resolves, otherwise global with the raw reference preserved.
- **Live effective duration** on the pipeline board: Monday–Friday in the planned window minus the union of auto-blocked days (Active master rows with valid inclusive ranges, excluding title/Activity/Detail matches — trim + case-insensitive) and manual + global exclusions. NSW holidays subtract only when the holiday configuration is marked `holidays.verified = true`; otherwise the figure is labelled provisional.
- **Calendar**: Active | Inactive | All filter (default Active).
- **Access**: new `department_admin` role rank; department administrators see their own department in full and nothing outside it; `canAdminDepartment` / `canManageDepartment` helpers; login lands on `/calendar`; switch-persona preview for department administrators; persona-exit bug fixed; login page no longer redirects to the retired `/` landing.
- **Validation**: new rules `activity.assignment_review` (warning) and `pipeline.needs_confirmation` (info) added to the catalogue and the Data Quality queue; unresolved assignees (`Sudeep/Mukti`, `Naweesh`, `Tristan`, `Sujan`) remain visible and never invented into people.
- **Re-import safety**: idempotent apply; confirmed verification status is never downgraded; a manually re-parented department survives re-import and is recorded as a conflict (never overwritten).
- **Operations**: `npm run db:hfm-import` (dry-run default) with `--apply` (automatic backup), `--verify` (23 checks), `--rollback`, `--json`, `--report`; `npm run db:set-password` for operator-set credentials; `npm run db:embed` embeds migrations for serverless bundles; demo seed no longer double-inserts changelog entries.
- **Tests**: 88 automated tests, 13 in the new `tests/hfm-import.test.mts` suite (payload guard, dry-run, apply, idempotency, department-move preservation, 23-check verification, fidelity spot checks, rollback).

## 1.3.0 — 2026-11 — Enhancement handovers archive themselves

Approved enhancement Markdown follows Building → Built → Archived. A merged implementation PR marks its handover Built; the completion workflow archives it and closes the request. In-app status reconciles from committed documents on bootstrap and on `/api/health` (`enhancementDocSync`).

## 1.2.0 — 2026-11 — One-time login welcome message

Signed, short-lived login flash shows a personalised two-second welcome after successful authentication; manual dismissal and `tab.dashboard` landing.

## 1.1.1 — 2026-11 — Serverless enhancement vault fallback

Enhancement writes fall back to `/tmp` on read-only serverless filesystems; downloads served from disk or the database.

## 1.1.0 — 2026-11 — FTE calendar and live enhancement drafting

FTE Calendar tab (`tab.fte`): activity × day demand matrix with per-activity, per-day and period totals against available people. Enhancement studio drafts every field in real time; every suggestion optional and editable.

## 1.0.x — Initial releases

Activity ledger, fiscal calendar, pipeline with eligibility exclusions, capacity grid, bug ledger with derived status, release governance, Data Quality validation queue, Import Centre, Master Setup, audit log, role-scoped visibility.
