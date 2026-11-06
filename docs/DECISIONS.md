# Decisions, defaults and open questions

Each item records the current behaviour, why, and what would change it. Items marked **Open** need a business confirmation — the app keeps a safe default until then.

## 1. Authentication
**Decision:** local accounts with scrypt password hashes and signed, http-only session cookies for the runnable build.
**Why:** the app must run without an external identity tenant to be testable.
**Production:** replace `lib/auth.ts` with the approved IdP (OIDC/SAML), keep the same `getSession()` contract, enforce MFA and least privilege. **Open** — which IdP and role mapping?

## 2. Visibility is downward-only
**Decision:** a person sees their own sub-tree, never their manager or anyone above. `admin` and `exec` get the holistic view. Unassigned work is visible to managers within their own department.
**Why:** matches the "ariel/holistic" requirement and prevents upward snooping.
**Open:** should peers on the same team see each other's work? Current default: no, unless a manager/exec is viewing.

## 3. Disabled departments
**Decision:** disabled departments are excluded from every operational view (calendars, capacity, reporting, pipeline) for all roles. Admin setup still shows them so they can be re-enabled; records are never deleted.
**Open:** should an exec still see a disabled department in read-only reporting? Default: no.

## 4. Only Active activities count
**Decision:** inactive activities never render, never count in KPIs and never block pipeline work. They remain in the database and can be reactivated.
**Parity note:** some legacy helper formulas omit Active filtering. The app applies the documented rule consistently; the Data Quality queue flags active work inside disabled departments.

## 5. Dates, duration and timezone
**Decision:** date-only fields (`YYYY-MM-DD`), inclusive ranges, `duration = end − start + 1` calendar days. Timestamps are ISO UTC, displayed in `Australia/Sydney`. Fiscal year starts in July; FY27 = Jul 2026 – Jun 2027.
**Why:** source parity and timezone-safe scheduling.

## 6. FTE resolution
**Decision (precedence):** explicit per-record override → Regression default `1` → stored FTE for non-Regression work → configured default `0.5`.
Hours conversion uses a configurable day length: default **7.6h** (source capacity), switchable to 8h. 4h = 0.5 FTE at 8h/day, 0.53 at 7.6h/day. Hours are never invented.
**Open:** confirm the approved hours→FTE divisor for reporting.

## 7. Capacity metric
**Decision:** occupied capacity = `(unavailable + DevOps + recording + QA) / total hours`. Fully unavailable days display "NA". Productive utilisation (QA only) is shown separately. Capacity is kept distinct from FTE demand.
**Why:** the source metric includes absence; treating it as productivity would misreport people.
**Open:** should the headline metric switch to productive utilisation? Default: no.

## 8. NSW public holidays
**Decision:** holidays are supplied configuration. 2026 and 2027 dates are seeded with a "verify against approved source" note. No holiday is ever fetched or invented.
**Action:** verify 2027 (and later) against the approved NSW Industrial Relations source before each fiscal year.

## 9. Deployment date parity
**Decision:** reproduce `start + weeks * 6`, then adjust to the next working day (weekends, NSW holidays) — not an assumed `weeks * 5`. Manual override dates are preserved and take display precedence.
**Open:** confirm whether the source shifts forward or backward on a non-working candidate day. Current default: forward.

## 10. Master Calendar vs Master Calendar (2)
**Decision:** not consolidated. Both are represented by one virtualised month view; meaningful differences would need the workbook to compare formulas.
**Open:** provide both sheets for a formula diff before consolidating.

## 11. QA Calendar display rules
**Decision:** active activities only, with optional pipeline overlay. Prior "activity-only" preferences are not assumed.
**Open:** confirm whether the legacy calendar intentionally hid pipeline rows; current default shows a combined view with a QA-only toggle.

## 12. AI assistance
**Decision:** a deterministic, local insight engine. It computes from the same queries the UI uses and lists its evidence. No operational data leaves the server. `AI_PROVIDER` exists so a hosted model can be added behind the same interface.
**Open:** if a hosted model is approved, complete a data-handling review and store the key in the secret store. Never send employee names or defect detail without approval.

## 13. Progress derivation
**Decision:** completion = `(closed + 0.75 × fixed) / reported`, unless a manual percentage/snapshot exists, which then wins. A bug shared across services is `Closed` only when every link is `Closed`.
**Open:** confirm the weighting for "fixed but unverified" (currently 75%).

## 14. Multi-assignee allocation
**Decision:** `activity_assignments` supports shares, but effort is attributed to the single `assignee_id` until shares are defined. The schema is ready; the UI does not split effort yet.
**Open:** define the allocation-share rule before attributing shared effort to people.

## 15. Import natural keys and unknowns
**Decision:** activities match on Calendar Item ID (falling back to activity + start), pipeline on recording code. Re-running an identical import is a no-op. Unparseable dates stay `NULL` and are queued in Data Quality. Narrative notes longer than 40 characters are archived verbatim rather than becoming activities.
**Why:** idempotency and "unknown stays unknown".

## 16. Overlap / blocking parity
**Decision:** an Active QA activity overlapping a recording day blocks that day. Inactive QA never does. Manual exclusions always win. The source has named exemptions (matching Activity/Detail) that are **not** reproduced.
**Open:** confirm the approved common rule for named exemptions before changing behaviour.

## 17. Demo data separation
**Decision:** synthetic rows carry `is_demo = 1` and are labelled "TEST"/demo in the UI. They are excluded from operational claims and can be removed by resetting a local database. Production instances set `SEED_DEMO_DATA=false`.

## 18. Deployment plan inheritance
**Decision:** application-level status/dates are only inherited when a service-level record exists; nothing is inferred from a plan. Manual overrides are preserved.
**Open:** confirm service-level inheritance rules with the release manager.

## 19. Audit and retention
**Decision:** every mutating action writes an `audit_events` row with actor and before/after JSON. Imported provenance is immutable. Retention period is not enforced by the app.
**Open:** agree retention (e.g. 7 years for release decisions) and any archival job.

## 20. Enhancements and GitHub
**Decision:** enhancements are stored in the database *and* written as Markdown into `enhancements/` in this repository. Archiving moves the file to `enhancements/archive/` so it is not reviewed again. A GitHub token is optional; the default flow is a human commit.
**Open:** should the app push directly via the GitHub API in CI? Requires a scoped token and PR policy.
