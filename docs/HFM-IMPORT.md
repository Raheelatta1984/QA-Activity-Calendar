# HFM workbook import — operator guide

This document covers the HarrisFarm Markets (HFM) QA workbook snapshot that ships embedded in this repository and how to apply, verify and reverse it. It is written for the operator running the import, not for developers.

**Snapshot:** `tblActivities` (master QA activities), `tblRecordingPipeline` (pending recording pipeline) and `tblPipelineManualExclusions` (manual exclusion dates), source extract dated **2026-11-09**, embedded as JSONL under `lib/hfm/` with a checksum-style payload guard — if the embedded payload does not match `lib/hfm/expected-counts.json`, the importer fails loudly and writes nothing.

## Quick start

```bash
npm run db:migrate          # applies 001..003 (fresh databases only need this + seed)
npm run db:seed             # reference + demo data (SEED_DEMO_DATA=true locally)

npm run db:hfm-import       # DRY-RUN: reconciles and prints the full report; writes nothing
npm run db:hfm-import -- --apply                 # commits in one transaction (automatic backup first)
npm run db:hfm-import -- --apply --no-backup     # skip the automatic backup (not recommended)
npm run db:hfm-import -- --verify                # read-only acceptance checks (23)
npm run db:hfm-import -- --rollback <import_batch_id> [--actor "Name"]
npm run db:hfm-import -- --json                  # machine-readable report
npm run db:hfm-import -- --report report.json    # write the full report to a file as well
npm run db:set-password -- --email ratta@harrisfarm.com.au --password-stdin
```

Dry-run is the default. `--apply` creates a consistent backup under `data/backups/` before writing anything, records an `import_batches` row and imports inside a single transaction.

## What gets created

| Entity | Source | Count |
| --- | --- | --- |
| Company `HarrisFarm Markets` (`code = 'HFM'`, `is_default = 1`) | organisation payload | 1 |
| Entity `Harrisfarm` | organisation payload | 1 |
| Department `HFM IT QA` under Harrisfarm | organisation payload | 1 |
| Damien Milthorpe — `department_admin` scoped to HFM IT QA | organisation payload | 1 |
| Raheel Atta — `admin` (application administrator), manager: Damien | organisation payload | 1 |
| Master activities | `tblActivities` | 52 (41 Active / 11 Inactive) |
| Pending pipeline records | `tblRecordingPipeline` | 15 |
| Manual exclusions | `tblPipelineManualExclusions` | 14 |

The demo seed and the HFM snapshot coexist: demo rows keep `is_demo = 1`; imported HFM rows carry `is_demo = 0`, `source_dataset`, `source_row`, `source_order`, `import_batch_id` and literal `external_source_id` values (e.g. `QA-00013`, `TEST-001`).

## People, roles and credentials — nothing is invented

- **Damien Milthorpe** is seeded with **no email and no password**. The source gives his name, designation, role and department scope — nothing else. He cannot sign in until an operator deliberately sets an email and password (Master Setup → People, or `npm run db:set-password`).
- **Raheel Atta** is resolved by the supplied email `ratta@harrisfarm.com.au`, mapped to application-scope `admin`, reporting to Damien Milthorpe. His password is also **not** created.
- Unresolved assignee labels from the workbook (`Sudeep/Mukti`, `Naweesh`, `Tristan`, `Sujan` — 12 activities) stay **unassigned** and surface as `activity.assignment_review` warnings in Data Quality. No person is ever created from a raw label.
- Give someone a login with:
  `npm run db:set-password -- --email <email> --password-stdin` (reads one line from stdin; minimum 10 characters; writes an audit event; the password is never logged).

## Provenance and fidelity rules

| Rule | Behaviour |
| --- | --- |
| Literal source IDs | `QA-008`, `QA-00013`, `TEST-001`, … are stored verbatim in `external_source_id` / `calendar_item_id`. Never renumber, never auto-pad. |
| Blank source values | `Automation`, `Recording Status`, `Current Status` stay `NULL`. Automation is also stored as `automation_fraction` (TEST-001 = 0.55). Blanks are never zero-filled. |
| Incomplete dates | A missing start or end stays `NULL`; the row stays in the unscheduled queue. Only a *reversed* range (both dates present, start after end) is nulled, with a warning. QA-0052 has no start date and keeps it. |
| Excel/date artifacts | Source `Duration = 0` with a missing end date is preserved as `source_duration_days = 0` and reported as a warning; nothing is "corrected". |
| Raw text | Notes, raw `&amp;` entities, `excluded_priority_work_dates` and `data_quality_warning`/`overlap_warning` snapshots are preserved byte-for-byte. Excluded priority work dates are **never** parsed into manual exclusions. |
| Active status | Source `Active Status` is authoritative: `Active` → active, anything else → Inactive for safety. Inactive rows never render, never count, never block. |
| TEST labels | `TEST-*` pipeline rows are kept verbatim: `is_test = 1`, `source_test_label = 1`, `verification_status = 'Needs operational confirmation'`. An **application administrator** flips a row to `Confirmed operational` from the pipeline board (audited `pipeline.verification_confirmed` event). The import never grants confirmation, and re-import never downgrades a confirmation. |
| Manual exclusions | Linked to their pipeline record when the referenced Pipeline ID resolves; otherwise stored as global exclusions with the raw reference preserved and a warning. |
| Source order | `source_order` on every imported row reproduces the workbook row order. |

## Effective (live) duration on the pipeline board

The pipeline board shows a live **effective Mon–Fri duration** next to the retained source `Duration Days` snapshot:

```
effective = |{ Mon–Fri dates in planned window }|
             − |union(auto-blocked days ∪ manual exclusion days ∪ global exclusion days)|
```

- **Auto-blocked day**: an Active master activity with a valid inclusive range overlaps the day, and the pipeline item's title does **not** match that activity's `Activity` or `Activity Detail` after `TRIM()` + case-insensitive comparison. A matching row suppresses its own block only — an unrelated conflicting activity on the same day still blocks.
- **Manual exclusions** always win and are deduplicated against the automatic block (union, not sum).
- **NSW public holidays** are subtracted only when the `holidays.verified` setting is `true` *and* the holiday table is populated. Until then the figure is labelled **provisional**; the number is always Monday–Friday minus the union above.
- Inactive or incomplete-date master rows never block. Inactive pipeline rows behave the same as active ones (the workbook has no separate rule).
- The source `Duration Days` snapshot is retained verbatim in `source_duration_days` and never overwritten by the live computation.

## Re-import, conflicts and rollback

- Re-running `--apply` is **idempotent**: unchanged rows are reported as `unchanged`, nothing is duplicated.
- **Migration-owned** fields refresh from the source on re-import (values derived from the workbook).
- **Portal-owned** fields are preserved: a human-assigned `assignee_id` (when unset in source), a `Confirmed operational` verification status, actual dates, priorities, notes written in-app.
- **Department moves are never reverted**: if a row was manually re-parented to another department, re-apply records a `department_id` conflict in the report and leaves the row where the human put it. To return a row to source ownership, move it back to `HFM IT QA` before re-importing — no conflict is then recorded.
- Every re-import that would change a populated field records a `conflict` entry (entity, id, field, source vs current) in the report — review the report; conflicts are not errors and never silently overwrite user work except the source-owned fields above.
- `--rollback <import_batch_id>` deletes **only** the rows imported by that batch (activities, pipeline rows, exclusions) and keeps everything else, including the organisation and demo data. It sets the batch status to `rolled_back` and writes audit events.

## Acceptance verification

`--verify` runs 23 read-only checks covering: the org scaffold (company/entity/department), both seeded people and their roles and scopes (Damien `department_admin` + `role_scope_department_id`, Raheel `admin`, reporting link), Damien's NULL email, the 52/41/11 and 15/14 counts, absence of duplicate IDs, literal source IDs, TEST preservation and verification flags, `TEST-001` = 0.55, `TEST-009` = unknown, unresolved assignees, incomplete-date staging. Expected output: `23 passed, 0 failed`.

## What the import will never do

- Never delete or relabel source records; rollback only removes imported rows.
- Never invent emails, passwords, people, dates, holidays, FTE values or relationships absent from the source.
- Never auto-match unresolved assignee labels to similarly named demo people.
- Never treat a TEST-labelled source row as operational without an explicit, audited owner action.
- Never fetch holidays, contacts or reference data from the network.

## Rollback runbook

1. `npm run db:hfm-import -- --verify` — confirm the current state.
2. `npm run db:hfm-import -- --rollback <import_batch_id> --actor "Your Name"` — the batch ID is printed by `--apply` and stored in `import_batches`.
3. `npm run db:hfm-import -- --verify` — counts drop to 0 for imported datasets; org rows remain.
4. Restore the automatic backup in `data/backups/` instead if you also need to revert portal-owned edits made against imported rows.
