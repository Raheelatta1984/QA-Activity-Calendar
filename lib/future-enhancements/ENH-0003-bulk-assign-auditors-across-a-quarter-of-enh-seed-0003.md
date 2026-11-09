---
ref: ENH-0003
title: Bulk-assign auditors across a quarter of scheduled audits
status: Building
tenant: qa-calendar
app: HFM QA Activity Calendar
submitted_by: sofia.marino@qa.demo
submitted_on: "2026-11-03T02:33:32.490Z"
area: Calendar
votes: 1
app_sections:
  - sec.calendar-grid
  - sec.calendar-filters
  - tab.calendar
ai_fields:
  - title
source: enhancements-hub/Raheelatta1984/QA-Activity-Calendar
---

# ENH-0003 — Bulk-assign auditors across a quarter of scheduled audits

> Give the planning team a way to assign one auditor to many scheduled audits at once, filtered by site and quarter, instead of opening each calendar entry.

## Brief

Assigning auditors one audit at a time makes the start-of-quarter planning week the busiest week of the quarter.

## Requirements

- Multi-select rows in the calendar grid
- Assign an auditor to the selection in one action
- Warn when an auditor already has a clash that day

## Impacts

Calendar grid and calendar filters; auditor records unchanged.

## Expected outcome

Quarter planning happens in one sitting instead of one week.

## Success criteria

1. 20 audits are assigned in a single action.
2. Clash warnings appear before saving.
3. Audit log records the bulk change.

## Outcome

Planning week becomes planning hour.

## App sections

- `sec.calendar-grid`
- `sec.calendar-filters`
- `tab.calendar`

## Author notes

## Bulk auditor assignment

Start-of-quarter planning is done one audit at a time.

### Requirements

- Multi-select in the calendar grid
- Assign in one action
- Warn on same-day clashes

---

_AI-drafted fields: title. Everything else was written by sofia.marino@qa.demo._
