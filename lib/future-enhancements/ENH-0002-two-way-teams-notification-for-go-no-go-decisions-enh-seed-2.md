---
ref: "ENH-0002"
title: "Two-way Teams notification for go/no-go decisions"
status: "Building"
submitted_by: "Grace Mbeki"
submitted_on: "2026-11-05"
app_sections: "sec.releases.governance"
source: "HFM QA Calendar — Future Enhancements"
---

# Two-way Teams notification for go/no-go decisions

## Brief
Release governance decisions are made in the app but the wider business still waits for an email.

## Requirements
- Teams webhook, opt-in per release, retry with an audit trail.
- No secrets in client code; consent recorded at tenant level.

## Impacts
- Releases, Integrations, Security
- Requires explicit tenant consent and a secret store entry.

## Expected outcome
A go/no-go decision posts to the release channel within a minute of being recorded.

## Success criteria
- 100% of decisions delivered or queued.
- Delivery failures visible in the audit log.
- No secrets rendered to the browser.

---

_Generated from the in-app enhancement vault._
