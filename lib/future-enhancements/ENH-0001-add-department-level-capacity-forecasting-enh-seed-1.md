---
ref: "ENH-0001"
title: "Add department-level capacity forecasting"
status: "Building"
submitted_by: "Lachlan Reid"
submitted_on: "2026-11-05"
app_sections: "sec.capacity.pivot, sec.capacity.demand"
source: "HFM QA Calendar — Future Enhancements"
---

# Add department-level capacity forecasting

## Brief
Capacity is currently reviewed month by month; leadership needs a rolling three-month forecast per department to plan contractors.

## Requirements
- Forecast view, department filter, export to CSV, FTE + hours modes.
- Show the contractor shortfall week by week.
- Reuse the resource-day entries; never assume an 8-hour day.

## Impacts
- Reporting, Capacity
- Adds a derived read model; no schema change required.

## Expected outcome
Three-month capacity forecast with contractor shortfall highlighted weekly, produced in under 5 seconds for 40 people.

## Success criteria
- Role model respected (manager/exec only).
- Verified for FY27 with holidays and month-over-quarter behaviour intact.
- Documented under What's New with affected section IDs.
- Automated tests cover the happy path and the failure path.

---

_Generated from the in-app enhancement vault. Review with every change set and archive once built and tested._
