import { all, get, run, setSetting, transaction } from "./db";
import { hashPassword } from "./auth";
import { uid } from "./ids";
import { addDays, fiscalYearBounds, fiscalYearOf, inclusiveDays, isoToday } from "./dates";

/**
 * Reference configuration + synthetic demo data.
 * Demo rows are flagged (is_demo = 1) and never presented as operational data.
 */

const today = () => isoToday();
const d = (offset: number) => addDays(today(), offset);

type TabSeed = {
  id: string;
  key: string;
  label: string;
  icon: string;
  href: string;
  group_name: string;
  description: string;
  min_role?: string;
  sort: number;
  department_scope?: string | null;
  sections: { id: string; label: string; description: string }[];
};

export const TAB_CATALOGUE: TabSeed[] = [
  {
    id: "tab.dashboard",
    key: "dashboard",
    label: "Dashboard",
    icon: "gauge",
    href: "/",
    group_name: "Workspace",
    description: "Progress, capacity and AI signals for the current fiscal month.",
    sort: 10,
    sections: [
      { id: "sec.dashboard.kpis", label: "Headline KPIs", description: "Active activities, FTE demand, utilisation and pipeline readiness." },
      { id: "sec.dashboard.progress", label: "Progress by assignee", description: "Completion percentage and status split per person." },
      { id: "sec.dashboard.capacity", label: "Capacity by assignee", description: "Occupied vs available hours for the selected month." },
      { id: "sec.dashboard.ai", label: "AI insights", description: "Deterministic risk and opportunity signals derived from live data." },
      { id: "sec.dashboard.trend", label: "Activity trend", description: "Planned vs actual starts across the fiscal quarter." },
      { id: "sec.dashboard.upcoming", label: "Starting in the next 7 days", description: "Planned starts only — actuals are recorded from the calendar drawer." },
    ],
  },
  {
    id: "tab.calendar",
    key: "calendar",
    label: "QA Calendar",
    icon: "calendar",
    href: "/calendar",
    group_name: "Workspace",
    description: "Fiscal-year month grid with holidays, weekends, current week and activity drill-down.",
    sort: 20,
    sections: [
      { id: "sec.calendar.filters", label: "Fiscal selectors", description: "Year, quarter and month selectors — month overrides quarter." },
      { id: "sec.calendar.grid", label: "Month grid", description: "Activities plotted by inclusive date range." },
      { id: "sec.calendar.legend", label: "Legend & holidays", description: "Colour dictionary and NSW public holidays in scope." },
    ],
  },
  {
    id: "tab.fte",
    key: "fte",
    label: "FTE Calendar",
    icon: "target",
    href: "/fte",
    group_name: "Workspace",
    description: "Planned activity × day FTE demand with totals, compared against the people available for resourcing.",
    sort: 25,
    sections: [
      { id: "sec.fte.filters", label: "Scope", description: "Period, department, activity group and assignee selectors." },
      { id: "sec.fte.summary", label: "FTE required vs available", description: "Demand, headcount supply, resourcing gap and over-allocated days." },
      { id: "sec.fte.grid", label: "Activity × day matrix", description: "FTE per activity per day with totals per row and per column." },
      { id: "sec.fte.resources", label: "Resource load", description: "Allocated FTE per person and demand by activity group." },
    ],
  },
  {
    id: "tab.pipeline",
    key: "pipeline",
    label: "Pipeline",
    icon: "layers",
    href: "/pipeline",
    group_name: "Workspace",
    description: "Combined QA + recording pipeline with overlap suppression and manual exclusions.",
    sort: 30,
    sections: [
      { id: "sec.pipeline.availability", label: "Availability", description: "Eligible recording days after weekends, holidays and manual exclusions." },
      { id: "sec.pipeline.board", label: "Recording pipeline", description: "Planned vs actual dates, automation %, blockers and warnings." },
      { id: "sec.pipeline.exclusions", label: "Manual exclusions", description: "Date-specific exclusions with an audited reason." },
    ],
  },
  {
    id: "tab.capacity",
    key: "capacity",
    label: "Capacity",
    icon: "activity",
    href: "/capacity",
    group_name: "Workspace",
    description: "Resource-day capacity, occupied capacity and FTE demand kept deliberately separate.",
    sort: 40,
    sections: [
      { id: "sec.capacity.grid", label: "Resource × day grid", description: "Hours per category, editable per person and date." },
      { id: "sec.capacity.pivot", label: "Monthly pivot", description: "Roll-up per person across the selected month." },
      { id: "sec.capacity.demand", label: "FTE demand vs capacity", description: "Active FTE demand over working days." },
    ],
  },
  {
    id: "tab.reporting",
    key: "reporting",
    label: "Reporting",
    icon: "bug",
    href: "/reporting",
    group_name: "Workspace",
    description: "Centralised bug reporting linked to activities and backend services.",
    sort: 50,
    sections: [
      { id: "sec.reporting.bugs", label: "Bug ledger", description: "Reported, fixed, closed and outstanding with derived status." },
      { id: "sec.reporting.progress", label: "Activity completion", description: "Progress bars per activity, from linked bugs or manual snapshots." },
      { id: "sec.reporting.services", label: "Service matrix", description: "Shared bug IDs across services — one outstanding link keeps the bug open." },
    ],
  },
  {
    id: "tab.releases",
    key: "releases",
    label: "Releases",
    icon: "rocket",
    href: "/releases",
    group_name: "Delivery",
    description: "Release feed, PQU release train and audited go/no-go governance.",
    sort: 60,
    sections: [
      { id: "sec.releases.feed", label: "Release feed", description: "Version, self-update and auto-update schedule entries." },
      { id: "sec.releases.pqu", label: "PQU schedule", description: "Release train, change cutoff and parses flagged for suspicion." },
      { id: "sec.releases.governance", label: "Release governance", description: "Regression status, go/no-go and deployment status decisions." },
    ],
  },
  {
    id: "tab.enhancements",
    key: "enhancements",
    label: "Future Enhancements",
    icon: "sparkles",
    href: "/enhancements",
    group_name: "Improvement",
    description: "Submit, review and archive enhancement proposals with live AI drafting and a markdown vault for GitHub.",
    sort: 70,
    sections: [
      { id: "sec.enhancements.intake", label: "Submit a proposal", description: "Live AI options for the outcome, impacted IDs, title, brief, requirements, impacts, expected outcome, success criteria and markdown handover — every field stays editable." },
      { id: "sec.enhancements.vault", label: "Enhancement vault", description: "Submitted, reviewed and archived requests with markdown export." },
      { id: "sec.enhancements.handovers", label: "Handover documents", description: "Building → Built → Archived handover Markdown in lib/future-enhancements/ with the status each document carries." },
    ],
  },
  {
    id: "tab.validation",
    key: "validation",
    label: "Data Quality",
    icon: "shield",
    href: "/validation",
    group_name: "Improvement",
    description: "Validation queue, overlap diagnostics and a documented rule catalogue.",
    sort: 80,
    sections: [
      { id: "sec.validation.issues", label: "Validation queue", description: "Missing dates, invalid ranges, duplicates, conflicts and orphans." },
      { id: "sec.validation.rules", label: "Rule catalogue", description: "Rule parity notes and active/inactive behaviour." },
    ],
  },
  {
    id: "tab.imports",
    key: "imports",
    label: "Import Centre",
    icon: "upload",
    href: "/imports",
    group_name: "Administration",
    description: "Idempotent workbook import with dry-run reconciliation and row provenance.",
    min_role: "manager",
    sort: 90,
    sections: [
      { id: "sec.imports.run", label: "Run an import", description: "Paste or upload source rows; always dry-run first." },
      { id: "sec.imports.history", label: "Batch history", description: "Counts, conflicts and per-row disposition." },
    ],
  },
  {
    id: "tab.setup",
    key: "setup",
    label: "Master Setup",
    icon: "settings",
    href: "/setup",
    group_name: "Administration",
    description: "Company, departments, hierarchy, employees, calendars and tab configuration.",
    min_role: "manager",
    sort: 100,
    sections: [
      { id: "sec.setup.company", label: "Company entity", description: "Legal entity, timezone and fiscal year start." },
      { id: "sec.setup.departments", label: "Departments", description: "Enable or disable departments without deleting data." },
      { id: "sec.setup.hierarchy", label: "Organisation hierarchy", description: "Drag-and-drop reporting lines with visibility rules." },
      { id: "sec.setup.people", label: "Employees", description: "Roles, capacity and department assignment." },
      { id: "sec.setup.tabs", label: "Tabs & sections", description: "Stable IDs, enable/disable toggles and AI sticky notes." },
      { id: "sec.setup.holidays", label: "Holidays & colours", description: "NSW public holidays and the colour dictionary." },
    ],
  },
  {
    id: "tab.changelog",
    key: "changelog",
    label: "What's New",
    icon: "megaphone",
    href: "/changelog",
    group_name: "Administration",
    description: "Every release, merge and PR change recorded in the app.",
    sort: 110,
    sections: [
      { id: "sec.changelog.releases", label: "Release notes", description: "Feature, fix, security and merge entries." },
      { id: "sec.changelog.about", label: "Build information", description: "Version, schema migrations and deployment details." },
    ],
  },
];

/**
 * Release notes shipped with the code. `ensureReference` writes them on a fresh
 * database; `ensureCatalogue` adds any version that is missing so an existing
 * installation still sees new releases in What's New.
 */
export const CHANGELOG_ENTRIES: Array<{
  version: string;
  title: string;
  offset: number;
  type: string;
  summary: string;
  items: string[];
  pr: number | null;
}> = [
  {
    version: "1.0.0",
    title: "QA Activity Calendar platform goes live",
    offset: 0,
    type: "feature",
    summary: "Complete rebuild of the HFM QA workbook as a persistent, role-aware web application.",
    items: [
      "Fiscal QA calendar with year/quarter/month selectors, holiday and current-week highlighting",
      "Activities CRUD with planned vs actual dates, FTE and progress tracking",
      "Combined QA + pipeline calendar with overlap suppression and manual exclusions",
      "Capacity planner, release governance and centralised bug reporting",
      "Org hierarchy with drag-and-drop, department enable/disable and per-employee views",
      "AI guidance sticky notes on every tab and section, each with a stable ID",
      "Future Enhancements vault with AI-drafted briefs and markdown export",
      "Idempotent import with dry-run reconciliation and validation queue",
    ],
    pr: 1,
  },
  {
    version: "1.0.1",
    title: "Hardening: tab toggles and audit trail",
    offset: -1,
    type: "fix",
    summary: "Disabled tabs no longer appear in navigation; audit events recorded for every write.",
    items: ["Tab/section enable state respected in the sidebar", "Audit log for activity, capacity and setup changes"],
    pr: 2,
  },
  {
    version: "1.0.2",
    title: "What's New panel added",
    offset: 0,
    type: "merge",
    summary: "Every merge now surfaces here so stakeholders can review changes inside the app.",
    items: ["Changelog viewer on its own tab", "Per-entry PR references"],
    pr: 3,
  },
  {
    version: "1.1.0",
    title: "FTE calendar by activity and live AI drafting",
    offset: 0,
    type: "feature",
    summary:
      "A dedicated FTE calendar shows planned activity × day demand with totals so testing resource can be arranged, and the enhancement studio now drafts every field in real time.",
    items: [
      "New FTE Calendar tab (tab.fte): activity × day FTE matrix with per-activity and per-day totals",
      "FTE vs people-available summary: demand, supply, resourcing gap, over-allocated days and headcount to cover",
      "Resource load rollup per person and demand split by activity group",
      "Month or fiscal-quarter scope, department/group/assignee filters, FTE ↔ hours toggle",
      "Enhancement studio drafts title, brief, requirements, impacts, outcome, success criteria, impacted IDs and the markdown handover live as you type",
      "Every AI suggestion is optional, replaceable and editable until the proposal is submitted",
    ],
    pr: 3,
  },
  {
    version: "1.1.1",
    title: "Serverless enhancement vault fallback (EROFS fix)",
    offset: 0,
    type: "fix",
    summary:
      "Submitting, archiving, regenerating or deleting an enhancement on read-only serverless filesystems (Vercel /var/task) now falls back cleanly to a writable /tmp vault instead of failing with EROFS.",
    items: [
      "Writable vault resolution falls back to /tmp/enhancements on Vercel and any read-only mount (EROFS/EACCES/EPERM)",
      "Enhancement submissions always persist to the database and download complete frontmatter Markdown via /api/enhancements/:id",
      "Archiving, reopening, regenerating and deleting proposals work without cross-device or read-only filesystem errors",
    ],
    pr: 4,
  },
  {
    version: "1.3.0",
    title: "Enhancement handovers archive themselves",
    offset: 0,
    type: "feature",
    summary:
      "Approved enhancement Markdown now follows a visible Building → Built → Archived lifecycle: a merged implementation marks its handover Built, the completion workflow archives the file, and the request status catches up on the next deployment instead of being edited by hand.",
    items: [
      "New Handover documents section (sec.enhancements.handovers) under Future Enhancements (tab.enhancements) shows every lib/future-enhancements/ file, its status and the matching request",
      "A merged implementation PR marks its handover Built before the file is moved to lib/future-enhancements/archived/ with status Archived",
      "Completion now also runs after the CI-gated merge workflow: automation-merged PRs are archived and their requests closed automatically",
      "In-app status is reconciled from the committed documents on bootstrap and from the vault, then confirmed on /api/health as enhancementDocSync",
      "Generated reconciliation reports live in the gitignored .tmp/ directory; the approved handover record stays in Git as the source of truth",
      "Calendar filters, FTE demand, release governance and role scoping are unchanged",
    ],
    pr: null,
  },
  {
    version: "1.2.0",
    title: "One-time login welcome message",
    offset: 0,
    type: "feature",
    summary: "A personalised welcome now greets each user after successful authentication and disappears after two seconds.",
    items: [
      "Signed, short-lived login flash ensures the message appears once and does not return on refresh or failed authentication",
      "Accessible application-shell notification with manual dismissal on the Dashboard landing tab (tab.dashboard)",
      "Calendar filters, scheduling, fiscal periods and holiday behaviour are unchanged",
    ],
    pr: null,
  },
];

export const AI_NOTES: Record<string, string> = {
  "tab.dashboard":
    "AI guidance · Start here for the monthly QA stand-up. Compare FTE demand against occupied capacity before adding work; the two are deliberately different metrics. Anything amber in the insights panel needs a decision this week.",
  "sec.dashboard.kpis":
    "AI guidance · These KPIs only count Active activities with a valid inclusive date range. Unscheduled records live in Data Quality — never silently dropped.",
  "sec.dashboard.progress":
    "AI guidance · Progress is derived from linked bug links first, then manual snapshots. Hover any bar to see the source so you can defend the number.",
  "sec.dashboard.capacity":
    "AI guidance · Occupied capacity includes leave and DevOps time — it is not productive utilisation. Treat >100% as a resourcing conversation, not a performance signal.",
  "sec.dashboard.ai":
    "AI guidance · Signals are generated locally from live data (no external model calls). Each signal lists the records it used, so it is auditable.",
  "sec.dashboard.trend":
    "AI guidance · Planned and actual starts are shown side by side. A gap is expected mid-flight; a permanent gap means actuals are not being recorded.",
  "sec.dashboard.upcoming":
    "AI guidance · Only planned starts appear here. Open the calendar drawer to record an actual start — the plan stays visible as a baseline.",
  "tab.calendar":
    "AI guidance · Pick the fiscal year first, then quarter, then month — month always wins. Dates are inclusive; a one-day activity appears once.",
  "sec.calendar.grid":
    "AI guidance · Inactive activities never render. Click a block to open the activity, then edit the plan or record the actual start.",
  "sec.calendar.legend":
    "AI guidance · Colour comes from the colour dictionary so the whole department reads the calendar the same way.",
  "tab.fte":
    "AI guidance · This is the resourcing view: which testing activity needs how much FTE on which day, and whether the team can cover it. Read the daily total row first — anything above the headcount needs a decision before the month starts.",
  "sec.fte.filters":
    "AI guidance · Scope defaults to the QA department with recording/pipeline rows excluded, so the numbers are testing effort only. Widen to All departments when a shared engineer is loaned across teams.",
  "sec.fte.summary":
    "AI guidance · Demand is summed per working day from every active testing activity; supply is headcount less recorded leave and DevOps time. A negative gap is a request for people, not a performance signal.",
  "sec.fte.grid":
    "AI guidance · Each cell is the FTE that activity needs on that day — not the total effort spread across the window. Switch to hours when you are arranging part-day cover with a contractor.",
  "sec.fte.resources":
    "AI guidance · Variance is measured against 1.0 FTE per person. Someone consistently over 1.0 across several days is the first conversation to have when re-sequencing the month.",
  "tab.pipeline":
    "AI guidance · QA and pipeline labels stay separate. An Active QA overlap blocks a recording day; inactive QA never does.",
  "sec.pipeline.availability":
    "AI guidance · Availability = weekdays − NSW holidays − manual exclusions. TEST records are demo rows and are excluded from operational KPIs.",
  "sec.pipeline.board":
    "AI guidance · Duration uses the later of planned/actual starts and ends — matching the source formula. Warnings flag narrative-only progress.",
  "sec.pipeline.exclusions":
    "AI guidance · Every exclusion needs a reason and an owner; it is written to the audit log.",
  "tab.capacity":
    "AI guidance · Total hours are not assumed to be 8. Per-person defaults (7.6) and explicit 4-hour days are preserved.",
  "sec.capacity.grid":
    "AI guidance · Edit hours inline. Unavailable hours stay visible so nobody is double-booked.",
  "sec.capacity.pivot":
    "AI guidance · The pivot mirrors the workbook layout but is computed on demand — no 1,281 precomputed columns.",
  "tab.reporting":
    "AI guidance · One bug can sit against several services. Overall status is derived: it closes only when every service link is closed.",
  "sec.reporting.bugs":
    "AI guidance · Use the shared-ID pattern when the same defect affects two services. The status pill shows the derived truth.",
  "tab.releases":
    "AI guidance · Planned and actual deployment dates are separate fields. A planned go-live is never treated as approval.",
  "sec.releases.pqu":
    "AI guidance · Parsed date ranges are flagged for review rather than silently corrected — check chronology before publishing.",
  "tab.enhancements":
    "AI guidance · Describe the pain, not the solution. The assistant drafts a title and success criteria you can edit before submitting.",
  "sec.enhancements.intake":
    "AI guidance · Paste a Markdown handover to attach the full context. The file is stored in the repository vault, not in a chat window.",
  "tab.validation":
    "AI guidance · Run the checks after every import. Resolve errors before relying on dashboards; warnings can be accepted with a reason.",
  "tab.imports":
    "AI guidance · Dry-run always writes a reconciliation report and changes nothing. Apply is idempotent on the natural key.",
  "tab.setup":
    "AI guidance · This is the control panel. Disabling a tab hides it from navigation for everyone without deleting any data.",
  "sec.setup.hierarchy":
    "AI guidance · Drag a person onto a new manager to move their whole sub-tree. Nobody can see upward — only their own team.",
  "sec.setup.departments":
    "AI guidance · Disable a department to take it out of operational views. Extend to a new department at any time — the app is built for it.",
  "sec.setup.tabs":
    "AI guidance · Every tab and section has a stable ID (tab.* / sec.*). Quote that ID in enhancement requests so changes are unambiguous.",
  "tab.changelog":
    "AI guidance · Add an entry for every PR or merge. This is the single place stakeholders look for 'what changed'.",
  "tab.imports.note": "",
  "sec.calendar.filters":
    "AI guidance · FY27 is July 2026 – June 2027. A month selection overrides the quarter, which overrides the fiscal year — the URL keeps the choice so a view can be shared.",
  "sec.capacity.demand":
    "AI guidance · FTE demand is a separate axis from capacity: this table sums Active FTE across inclusive dates. Blank cells mean nothing was planned, which is not the same as zero effort.",
  "sec.changelog.releases":
    "AI guidance · Add an entry with every pull request or merge. Version, type and PR reference make regressions traceable to a change.",
  "sec.changelog.about":
    "AI guidance · Build information is read-only evidence for support calls: schema migrations applied, table count, AI provider and whether demo rows exist.",
  "sec.enhancements.vault":
    "AI guidance · Each proposal keeps its Markdown file in enhancements/. Archiving moves it to enhancements/archive/ so a shipped request is never re-reviewed.",
  "sec.enhancements.handovers":
    "AI guidance · Building publishes the handover, Built means the implementation merged and Archived means the file now lives in lib/future-enhancements/archived/. The deployment that contains the moved file updates the request status, so never archive by hand.",
  "sec.imports.history":
    "AI guidance · Batch history is the audit trail for every import: dry runs write nothing to activities and every row keeps its disposition and source row number.",
  "sec.imports.run":
    "AI guidance · Always dry-run first and reconcile the counts. Re-running an identical file must report 'skipped', never duplicate records.",
  "sec.releases.feed":
    "AI guidance · Feed entries preserve the source link but never fetch it automatically. Mark a link verified only after a human has checked it.",
  "sec.releases.governance":
    "AI guidance · A planned status is never treated as approval. Go is only valid with regression Passed; No-Go cannot be marked Deployed.",
  "sec.reporting.progress":
    "AI guidance · Completion is derived from linked bugs (closed = 100%, fixed = 75%) unless a manual snapshot exists. The formula is shown next to the bar so it can be defended.",
  "sec.reporting.services":
    "AI guidance · One bug ID across two services counts once overall and once per service. The derived badge only closes when every service link is closed.",
  "sec.setup.company":
    "AI guidance · Company timezone and fiscal start drive every date calculation. Change them deliberately — historical labels are not recalculated.",
  "sec.setup.holidays":
    "AI guidance · Supply NSW public holidays from the approved source. Holidays are configuration, never fetched or invented, and feed capacity, FTE and pipeline logic.",
  "sec.setup.people":
    "AI guidance · Roles decide what a person can see and edit. Reporting lines are downward-only: a person never sees their manager's activities.",
  "sec.validation.issues":
    "AI guidance · Queued records are unknown data, not errors to be guessed at. Fix the source value, then re-run checks — resolve an issue only when the data is genuinely corrected.",
  "sec.validation.rules":
    "AI guidance · The rule catalogue is the contract behind the queue. Every error blocks a report or a release gate; warnings need a recorded decision.",
};

export function ensureReference() {
  if (get<{ n: number }>("SELECT COUNT(*) AS n FROM companies")?.n) return false;

  transaction(() => {
    const companyId = "co_hfm";
    run(
      `INSERT INTO companies (id, name, legal_name, timezone, fiscal_start_month) VALUES (?, ?, ?, ?, ?)`,
      companyId,
      "HFM",
      "HFM Quality Engineering (demo entity)",
      "Australia/Sydney",
      7
    );

    const departments = [
      ["dept_qa", "QA", "Quality Engineering", "Functional, regression and automation QA.", "#4f8cff", 1, 10],
      ["dept_rel", "REL", "Release Management", "Release trains, deployment windows and governance.", "#a855f7", 1, 20],
      ["dept_devops", "DEVOPS", "DevOps", "Environment, build and tooling enablement.", "#22c55e", 1, 30],
      ["dept_prod", "PROD", "Product Ownership", "Backlog, business analysis and acceptance.", "#f59e0b", 1, 40],
      ["dept_pay", "PAY", "Payments (paused)", "Legacy payments stream — disabled for FY27.", "#ef4444", 0, 50],
    ] as const;
    for (const [id, code, name, description, colour, enabled, sort] of departments) {
      run(
        `INSERT INTO departments (id, company_id, code, name, description, colour, enabled, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        companyId,
        code,
        name,
        description,
        colour,
        enabled,
        sort
      );
    }

    const people: Array<[string, string | null, string | null, string, string, string, string, string, number]> = [
      ["p_priya", null, null, "Priya Raman", "priya.raman@hfm.demo", "Chief Operating Officer", "exec", "#6366f1", 1],
      ["p_amara", "p_priya", "dept_qa", "Amara Okafor", "amara.okafor@hfm.demo", "Head of Quality Engineering", "admin", "#4f8cff", 1],
      ["p_lachlan", "p_amara", "dept_qa", "Lachlan Reid", "lachlan.reid@hfm.demo", "QA Manager", "manager", "#0ea5e9", 1],
      ["p_sofia", "p_lachlan", "dept_qa", "Sofia Marchetti", "sofia.marchetti@hfm.demo", "Senior QA Engineer", "editor", "#14b8a6", 1],
      ["p_tom", "p_lachlan", "dept_qa", "Tom Nguyen", "tom.nguyen@hfm.demo", "QA Engineer", "editor", "#8b5cf6", 1],
      ["p_hana", "p_lachlan", "dept_qa", "Hana Suzuki", "hana.suzuki@hfm.demo", "QA Analyst", "viewer", "#f472b6", 1],
      ["p_grace", "p_amara", "dept_rel", "Grace Mbeki", "grace.mbeki@hfm.demo", "Release Manager", "manager", "#a855f7", 1],
      ["p_oliver", "p_grace", "dept_rel", "Oliver Brandt", "oliver.brandt@hfm.demo", "Release Coordinator", "editor", "#c084fc", 1],
      ["p_marcus", "p_amara", "dept_devops", "Marcus Lee", "marcus.lee@hfm.demo", "DevOps Lead", "manager", "#22c55e", 1],
      ["p_aisha", "p_marcus", "dept_devops", "Aisha Khan", "aisha.khan@hfm.demo", "DevOps Engineer", "editor", "#4ade80", 1],
      ["p_ella", "p_priya", "dept_prod", "Ella Fitzgerald", "ella.fitzgerald@hfm.demo", "Product Owner", "manager", "#f59e0b", 1],
      ["p_noah", "p_ella", "dept_prod", "Noah Patel", "noah.patel@hfm.demo", "Business Analyst", "viewer", "#fb923c", 1],
    ];
    const pw = hashPassword("demo1234");
    for (const [id, manager, dept, name, email, title, role, colour, active] of people) {
      run(
        `INSERT INTO people (id, department_id, manager_id, name, email, title, role, password_hash, colour, active, is_demo, capacity_hours_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        id,
        dept,
        manager,
        name,
        email,
        title,
        role,
        pw,
        colour,
        active,
        role === "viewer" ? 7.6 : 7.6
      );
    }

    // NSW public holidays — supplied reference data. Verify against the approved
    // NSW Industrial Relations source each year (see docs/DECISIONS.md #8).
    const holidays: Array<[string, string]> = [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-26", "Australia Day"],
      ["2026-04-03", "Good Friday"],
      ["2026-04-04", "Easter Saturday"],
      ["2026-04-05", "Easter Sunday"],
      ["2026-04-06", "Easter Monday"],
      ["2026-04-27", "Anzac Day (observed)"],
      ["2026-06-08", "King's Birthday"],
      ["2026-10-05", "Labour Day"],
      ["2026-12-25", "Christmas Day"],
      ["2026-12-26", "Boxing Day"],
      ["2026-12-28", "Boxing Day (additional)"],
      ["2027-01-01", "New Year's Day"],
      ["2027-01-26", "Australia Day"],
      ["2027-03-26", "Good Friday"],
      ["2027-03-27", "Easter Saturday"],
      ["2027-03-28", "Easter Sunday"],
      ["2027-03-29", "Easter Monday"],
      ["2027-04-26", "Anzac Day (observed)"],
      ["2027-06-14", "King's Birthday"],
      ["2027-10-04", "Labour Day"],
      ["2027-12-25", "Christmas Day"],
      ["2027-12-27", "Christmas Day (observed)"],
      ["2027-12-28", "Boxing Day (observed)"],
    ];
    for (const [date, name] of holidays) {
      run(
        `INSERT OR IGNORE INTO holidays (id, date, name, jurisdiction, year, source) VALUES (?, ?, ?, 'NSW', ?, 'Demo reference — verify against approved NSW source')`,
        uid("hol"),
        date,
        name,
        Number(date.slice(0, 4))
      );
    }

    const colours: Array<[string, string, string, string]> = [
      ["Regression", "#4f8cff", "Active regression cycle", "activity"],
      ["Automation", "#14b8a6", "Automation build or maintenance", "activity"],
      ["Performance", "#f59e0b", "Load, stress and performance testing", "activity"],
      ["Security", "#ef4444", "Security and penetration testing", "activity"],
      ["Integration", "#a855f7", "Cross-system integration testing", "activity"],
      ["UAT", "#22c55e", "User acceptance testing", "activity"],
      ["Recording", "#8b5cf6", "Test recording and maintain", "pipeline"],
      ["Pipeline", "#64748b", "Eligible recording day", "pipeline"],
      ["Holiday", "#94a3b8", "NSW public holiday", "calendar"],
      ["Blocked", "#dc2626", "Blocked by dependency", "activity"],
    ];
    for (const [name, hex, meaning, applies] of colours) {
      run(
        `INSERT INTO colour_rules (id, name, hex, meaning, applies_to) VALUES (?, ?, ?, ?, ?)`,
        uid("col"),
        name,
        hex,
        meaning,
        applies
      );
    }

    for (const tab of TAB_CATALOGUE) {
      run(
        `INSERT INTO tabs (id, key, label, icon, href, description, group_name, enabled, sort_order, min_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        tab.id,
        tab.key,
        tab.label,
        tab.icon,
        tab.href,
        tab.description,
        tab.group_name,
        tab.sort,
        tab.min_role ?? "viewer"
      );
      tab.sections.forEach((section, index) => {
        run(
          `INSERT INTO sections (id, tab_id, label, description, enabled, sort_order) VALUES (?, ?, ?, ?, 1, ?)`,
          section.id,
          tab.id,
          section.label,
          section.description,
          (index + 1) * 10
        );
      });
    }

    for (const [scope, content] of Object.entries(AI_NOTES)) {
      if (!content) continue;
      const tabId = scope.startsWith("sec.")
        ? TAB_CATALOGUE.find((t) => t.sections.some((s) => s.id === scope))?.id
        : scope;
      if (!tabId) continue;
      run(
        `INSERT INTO sticky_notes (id, tab_id, section_id, title, content, colour, ai_generated, pinned, enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        uid("note"),
        tabId,
        scope.startsWith("sec.") ? scope : null,
        scope.startsWith("sec.") ? "AI guidance" : "AI guidance for this tab",
        content,
        "#eef2ff"
      );
    }

    setSetting("app.name", "HFM QA Activity Calendar");
    setSetting("app.timezone", "Australia/Sydney");
    setSetting("fiscal.start_month", "7");
    setSetting("capacity.include_unavailable", "true");
    setSetting("fte.regression_value", "1");
    setSetting("fte.default_value", "0.5");
    setSetting("fte.hours_per_day", "7.6");
    setSetting("pipeline.blocking_rule", "active-qa-overlap");
    setSetting("org.visibility_rule", "subtree-downward");
    setSetting("demo.seeded", "true");
  });

  return true;
}

export function seedDemoData() {
  if (get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")?.n) return false;
  const fy = fiscalYearOf(today());
  const fyBounds = fiscalYearBounds(fy.startYear);

  transaction(() => {
    // ------------------------------------------------------------------ applications
    const apps: Array<[string, string, string]> = [
      ["app_hfmcore", "HFM Core", "Core financial modelling application"],
      ["app_hfmweb", "HFM Web", "Public-facing web workspace"],
      ["app_hfmdw", "HFM Data Warehouse", "Reporting and analytics warehouse"],
    ];
    for (const [id, name, description] of apps) {
      run(
        `INSERT INTO applications (id, name, code, description, enabled) VALUES (?, ?, ?, ?, 1)`,
        id,
        name,
        name.replace(/\s+/g, "-").toUpperCase(),
        description
      );
    }
    const services: Array<[string, string, string]> = [
      ["svc_core_api", "app_hfmcore", "Core API"],
      ["svc_core_calc", "app_hfmcore", "Calculation Engine"],
      ["svc_web_ui", "app_hfmweb", "Web UI"],
      ["svc_web_auth", "app_hfmweb", "Identity Gateway"],
      ["svc_dw_etl", "app_hfmdw", "ETL Pipeline"],
    ];
    for (const [id, app, name] of services) {
      run(
        `INSERT INTO backend_services (id, application_id, name, enabled) VALUES (?, ?, ?, 1)`,
        id,
        app,
        name
      );
    }

    // ------------------------------------------------------------------ activities
    type Act = {
      activity: string;
      detail: string;
      group: string;
      person: string | null;
      start: number;
      end: number;
      status: string;
      fte?: number | null;
      progress?: number;
      active?: number;
      priority?: string;
      notes?: string;
      actualStart?: number;
      actualEnd?: number;
      dept: string;
    };
    const activityRows: Act[] = [
      { activity: "FY27 Q2 Regression", detail: "Core financial regression cycle — build 27.4", group: "Regression", person: "p_sofia", start: -24, end: 5, status: "In Progress", fte: 1, progress: 62, priority: "High", actualStart: -24, dept: "dept_qa" },
      { activity: "Regression — Calculation Engine", detail: "Workbook parity checks on calc engine", group: "Regression", person: "p_tom", start: -14, end: 8, status: "In Progress", fte: 1, progress: 40, actualStart: -13, dept: "dept_qa" },
      { activity: "Automation sprint 14", detail: "Playwright suite for release-critical flows", group: "Automation", person: "p_hana", start: -10, end: 12, status: "In Progress", fte: 0.5, progress: 55, dept: "dept_qa" },
      { activity: "Performance soak", detail: "12-hour soak test on reporting service", group: "Performance", person: "p_sofia", start: 3, end: 7, status: "Planned", fte: 0.5, dept: "dept_qa" },
      { activity: "Security regression", detail: "OWASP top-10 pass before PQU cutover", group: "Security", person: "p_tom", start: 10, end: 16, status: "Planned", fte: 0.5, dept: "dept_qa" },
      { activity: "UAT — Nov release", detail: "Business sign-off with Product", group: "UAT", person: "p_ella", start: 4, end: 14, status: "Planned", fte: 0.5, dept: "dept_prod" },
      { activity: "Integration — Core to DW", detail: "Nightly ETL contract tests", group: "Integration", person: "p_aisha", start: -6, end: 9, status: "In Progress", fte: 0.5, progress: 30, dept: "dept_devops" },
      { activity: "Smoke — 27.4 deployment", detail: "Post-deploy smoke pack", group: "Regression", person: "p_hana", start: 18, end: 18, status: "Planned", fte: 0.5, dept: "dept_qa" },
      { activity: "Automation maintenance", detail: "Flaky-test triage and optimisation", group: "Automation", person: "p_tom", start: -30, end: -5, status: "Complete", fte: 0.5, progress: 100, actualStart: -30, actualEnd: -6, dept: "dept_qa" },
      { activity: "Release readiness review", detail: "Evidence pack for go/no-go", group: "Regression", person: "p_grace", start: 1, end: 3, status: "In Progress", fte: 0.5, progress: 45, actualStart: 1, dept: "dept_rel" },
      { activity: "PQU 27.4 regression", detail: "Regression for PQU release train 27.4", group: "Regression", person: "p_oliver", start: 8, end: 22, status: "Planned", fte: 1, dept: "dept_rel" },
      { activity: "Environment hardening", detail: "TLS and certificate rotation", group: "Security", person: "p_marcus", start: -18, end: 2, status: "In Progress", fte: 0.5, progress: 70, actualStart: -17, dept: "dept_devops" },
      { activity: "API contract validation", detail: "OpenAPI diffing in CI", group: "Automation", person: "p_aisha", start: 20, end: 34, status: "Planned", fte: 0.5, dept: "dept_devops" },
      { activity: "Holiday change freeze", detail: "No deployments 20 Dec – 5 Jan", group: "Regression", person: "p_grace", start: 44, end: 60, status: "Planned", fte: 0.5, dept: "dept_rel" },
      { activity: "Regression — January baseline", detail: "Baseline rebuild after freeze", group: "Regression", person: "p_sofia", start: 62, end: 76, status: "Planned", fte: 1, dept: "dept_qa" },
      { activity: "UAT — Payments (paused)", detail: "Paused stream retained for history", group: "UAT", person: "p_noah", start: -40, end: -25, status: "Planned", fte: 0.5, dept: "dept_qa" },
      { activity: "Exploratory testing — billing", detail: "Session-based exploration", group: "Regression", person: null, start: 25, end: 29, status: "Planned", fte: 0.5, dept: "dept_qa" },
      { activity: "Accessibility audit", detail: "WCAG 2.2 AA sweep of web workspace", group: "UAT", person: "p_ella", start: 28, end: 39, status: "Planned", fte: 0.5, dept: "dept_prod" },
      { activity: "Inactive: legacy regression", detail: "Retained inactive record for parity", group: "Regression", person: "p_tom", start: -60, end: -40, status: "Complete", fte: 0.5, active: 0, dept: "dept_qa" },
      { activity: "Unscheduled: mobile app QA", detail: "Dates unknown — awaiting product plan", group: "Regression", person: null, start: 0, end: 0, status: "Planned", fte: 0.5, dept: "dept_qa" },
    ];

    activityRows.forEach((a, index) => {
      const id = `act_${String(index + 1).padStart(3, "0")}`;
      const isUnscheduled = a.activity.startsWith("Unscheduled");
      const start = isUnscheduled ? null : d(a.start);
      const end = isUnscheduled ? null : d(a.end);
      const fte = a.group === "Regression" ? 1 : a.fte ?? 0.5;
      run(
        `INSERT INTO activities
          (id, code, department_id, activity, detail, activity_group, rule_type, active, start_date, end_date, duration_days,
           fte, colour, assignee_id, status, notes, data_quality, calendar_item_id, planned_start, planned_end,
           actual_start, actual_end, progress_percent, priority, is_demo, source_sheet, source_row, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'tblActivities', ?, datetime('now'), datetime('now'))`,
        id,
        `CI-${String(1001 + index)}`,
        a.dept,
        a.activity,
        a.detail,
        a.group,
        a.group === "Regression" ? "Standard" : "Effort",
        a.active === 0 ? 0 : 1,
        start,
        end,
        start && end ? inclusiveDays(start, end) : null,
        fte,
        colourForGroup(a.group),
        a.person,
        a.status,
        a.notes ?? null,
        isUnscheduled ? "Unscheduled — dates unknown" : null,
        `CI-${String(1001 + index)}`,
        start,
        end,
        a.actualStart !== undefined ? d(a.actualStart) : null,
        a.actualEnd !== undefined ? d(a.actualEnd) : null,
        a.progress ?? (a.status === "Complete" ? 100 : 0),
        a.priority ?? "Normal",
        index + 2
      );

      if (a.person && a.group !== "Regression") {
        run(
          `INSERT OR IGNORE INTO activity_assignments (id, activity_id, person_id, share) VALUES (?, ?, ?, 1.0)`,
          uid("asg"),
          id,
          a.person
        );
      }

      if (a.progress !== undefined) {
        run(
          `INSERT INTO progress_snapshots (id, activity_id, as_of, reported, fixed, closed, outstanding, progress_percent, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uid("ps"),
          id,
          d(-1),
          12,
          8,
          6,
          6,
          a.progress,
          "Demo snapshot"
        );
      }
    });

    // ------------------------------------------------------------------ pipeline
    // Windows are chosen to demonstrate both eligibility and QA-overlap blocking:
    // QA regression coverage in the demo data runs across the current month and
    // the Dec/Jan release windows, leaving deliberate gaps for recordings.
    const pipeline: Array<[string, string, number, number, number | null, number | null, string, string, number, string | null, number]> = [
      ["Core onboarding recording", "Guided onboarding walkthrough", 17, 22, 17, null, "Recording", "In progress", 45, null, 0],
      ["Billing reconciliation demo", "Month-end recon flow", 20, 30, null, null, "Planned", "Blocked", 0, "Awaiting environment refresh", 0],
      ["Reporting dashboard tour", "New analytics workspace", -45, -38, -45, -40, "Recorded", "Complete", 100, null, 0],
      ["Payments migration walkthrough", "Legacy cutover narrative", 61, 70, null, null, "On hold", "Blocked", 15, "Waiting on Payments SME", 0],
      ["Accessibility fixes demo", "WCAG remediation proof", 77, 86, null, null, "Planned", "Pending", 0, null, 0],
      ["Test recording — rehearsal", "TEST record (not operational)", 17, 19, null, null, "Recording", "Testing", 10, null, 1],
      ["Automation health recording", "Nightly suite health for stakeholders", 90, 99, null, null, "Planned", "Pending", 0, null, 0],
      ["Release 27.4 highlight reel", "What's new in 27.4", 40, 43, null, null, "Scripted", "Pending", 20, null, 0],
    ];
    pipeline.forEach((p, i) => {
      const [activity, detail, ps, pe, as, ae, recStatus, curStatus, automation, blocker, isTest] = p;
      const start = d(ps);
      const end = d(pe);
      run(
        `INSERT INTO recording_pipeline
          (id, code, department_id, activity, detail, planned_start, planned_end, actual_start, actual_end, duration_days,
           recording_status, current_status, automation_percent, blocker, colour, assignee_id, is_test, notes, source_sheet, source_row)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tblRecordingPipeline', ?)`,
        `pipe_${i + 1}`,
        `REC-${String(201 + i)}`,
        i < 3 ? "dept_qa" : "dept_rel",
        activity,
        detail,
        start,
        end,
        as !== null ? d(as) : null,
        ae !== null ? d(ae) : null,
        inclusiveDays(start, end),
        recStatus,
        curStatus,
        automation,
        blocker,
        isTest ? "#f59e0b" : "#8b5cf6",
        i % 2 === 0 ? "p_sofia" : "p_oliver",
        isTest,
        isTest ? "TEST record — demo only, not operational." : null,
        i + 2
      );
    });

    run(`INSERT INTO pipeline_exclusions (id, pipeline_id, date, reason, created_by)
         VALUES (?, NULL, ?, 'Team planning day', 'p_lachlan')`, uid("exc"), d(6));
    run(`INSERT INTO pipeline_exclusions (id, pipeline_id, date, reason, created_by)
         VALUES (?, 'pipe_2', ?, 'Billing environment unavailable', 'p_grace')`, uid("exc"), d(9));

    // ------------------------------------------------------------------ releases
    const feed: Array<[string, string, number, string, string, number]> = [
      ["27.4.0", "Self Update", -2, "Regression sign-off pending", "https://example.invalid/releases/27.4.0", 0],
      ["27.3.2", "Auto Update", -16, "Patch deployed to production", "https://example.invalid/releases/27.3.2", 0],
      ["27.3.1", "Auto Update", -30, "Hotfix for calculation drift", "", 0],
      ["27.3.0", "Self Update", -45, "Minor release", "https://example.invalid/releases/27.3.0", 0],
      ["27.4.1", "Self Update", 12, "Planned follow-up", "", 0],
      ["27.5.0", "Auto Update", 40, "Planned — change freeze applies", "", 0],
    ];
    feed.forEach(([version, kind, off, notes, link, verified]) =>
      run(
        `INSERT INTO release_feed (id, version, kind, date, notes, link, link_verified, department_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dept_rel')`,
        uid("rf"),
        version,
        kind,
        d(off),
        notes,
        link || null,
        verified
      )
    );

    const trains: Array<[string, number, number, string, string, string, string | null]> = [
      ["PQU 27.4", 4, 14, "In progress", "27.4.0", "2026.10", null],
      ["PQU 27.5", 26, 14, "Planned", "27.5.0", "2026.11", null],
      ["PQU 27.3", -40, 12, "Complete", "27.3.2", "2026.09", null],
      ["PQU 28.1", 120, 10, "Planned", "28.1.0", "2027.01", "Chronology: cutoff after train start — confirm"],
    ];
    trains.forEach(([train, cutoff, duration, status, appVersion, platformVersion, flag]) =>
      run(
        `INSERT INTO pqu_trains (id, train, change_cutoff, duration_days, status, app_version, platform_version, date_text_raw, flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid("pqu"),
        train,
        d(cutoff),
        duration,
        status,
        appVersion,
        platformVersion,
        `Cutoff ${d(cutoff)} · ${duration} days`,
        flag
      )
    );

    const gov: Array<[string, string, string, string, string]> = [
      ["27.4.0", "Passed", "Go", "Deployed", "Evidence pack complete; no open Sev-1."],
      ["27.3.2", "Passed", "Go", "Deployed", "Patch verified in staging."],
      ["27.4.1", "In progress", "Pending", "Not deployed", "Awaiting regression window."],
      ["27.5.0", "Not started", "Pending", "Not deployed", "Awaiting scope lock."],
    ];
    gov.forEach(([version, regression, goNoGo, deployment, notes], i) =>
      run(
        `INSERT INTO release_governance (id, release_id, version, regression_status, go_no_go, deployment_status, decided_by, decided_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid("gov"),
        `REL-${version}`,
        version,
        regression,
        goNoGo,
        deployment,
        goNoGo === "Go" ? "p_grace" : null,
        goNoGo === "Go" ? d(-2 + i) : null,
        notes
      )
    );

    run(
      `INSERT INTO service_deployment_plans (id, application_id, service, start_date, weeks, planned_date, actual_date, notes)
       VALUES (?, 'app_hfmcore', 'Core API', ?, 2, ?, NULL, 'Source parity: start + weeks*6 then workday adjustment')`,
      uid("sdp"),
      d(-10),
      d(4)
    );
    run(
      `INSERT INTO service_deployment_plans (id, application_id, service, start_date, weeks, planned_date, actual_date, manual_override_date, notes)
       VALUES (?, 'app_hfmweb', 'Web UI', ?, 1, ?, ?, NULL, 'Manual override preserved from workbook')`,
      uid("sdp"),
      d(-20),
      d(-4),
      d(-3)
    );

    // ------------------------------------------------------------------ capacity
    for (const person of ["p_sofia", "p_tom", "p_hana", "p_oliver", "p_aisha"]) {
      for (let i = 0; i < 25; i += 1) {
        const date = d(i);
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (day === 0 || day === 6) continue;
        const seed = i * 7 + person.length;
        const notAvailable = seed % 11 === 0 ? 4 : 0;
        const devops = person === "p_aisha" ? (seed % 3 === 0 ? 2.6 : 0) : 0;
        const recording = person === "p_oliver" ? (seed % 4 === 0 ? 3.6 : 0) : 0;
        const total = person === "p_tom" && seed % 13 === 0 ? 4 : 7.6;
        const qa = Math.max(0, total - notAvailable - devops - recording);
        run(
          `INSERT INTO resource_day_capacity (id, person_id, date, not_available_hours, devops_hours, recording_hours, qa_testing_hours, total_hours, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
          uid("cap"),
          person,
          date,
          notAvailable,
          devops,
          recording,
          qa,
          total
        );
      }
    }

    // ------------------------------------------------------------------ bugs
    const bugs: Array<[string, string, string, string, number, string, string[], string]> = [
      ["HFM-1041", "Calculation engine drifts on FX rounding", "Critical", "Open", -12, "act_001", ["svc_core_calc", "svc_web_ui"], "Reproducible with 3-decimal currencies."],
      ["HFM-1042", "Session timeout message not localised", "Low", "Fixed", -10, "act_003", ["svc_web_auth"], "Fix in 27.4.0."],
      ["HFM-1043", "ETL retries duplicate rows", "High", "Open", -8, "act_007", ["svc_dw_etl"], "Needs idempotency key."],
      ["HFM-1044", "Regression: report export truncates >5k rows", "High", "Closed", -6, "act_001", ["svc_core_api"], "Verified by Hana."],
      ["HFM-1045", "Accessibility: focus trap in modal", "Medium", "Open", -5, "act_018", ["svc_web_ui"], "WCAG fail on dialog."],
      ["HFM-1046", "Soak test memory growth", "High", "Open", -3, "act_004", ["svc_core_api"], "Tracked from performance backlog."],
      ["HFM-1047", "Audit log missing actor on bulk update", "Medium", "Fixed", -2, "act_012", ["svc_core_api"], "Awaiting deploy."],
      ["HFM-1048", "Regression parity: FTE rounding differs", "Medium", "Open", -1, "act_002", ["svc_core_calc"], "Source formula vs app rounding."],
      ["HFM-1049", "Duplicate invoice notes on import", "Low", "Closed", -20, "act_009", ["svc_dw_etl"], "Fixed in maintenance."],
      ["HFM-1050", "SSO redirect loop on Safari", "Critical", "Fixed", -4, "act_005", ["svc_web_auth"], "Hotfix pending release."],
    ];
    bugs.forEach(([key, title, severity, status, offset, activityId, svcList, notes], index) => {
      run(
        `INSERT INTO bugs (id, bug_key, title, severity, status, reported_date, reported_by, activity_id, notes, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        `bug_${index + 1}`,
        key,
        title,
        severity,
        status,
        d(offset),
        index % 2 === 0 ? "p_hana" : "p_sofia",
        activityId,
        notes
      );
      svcList.forEach((svc, svcIndex) => {
        const linkStatus =
          status === "Closed"
            ? "Closed"
            : status === "Fixed"
              ? svcIndex === 0
                ? "Fixed"
                : "Fixed"
              : "Open";
        run(
          `INSERT INTO bug_service_links (id, bug_id, service_id, status) VALUES (?, ?, ?, ?)`,
          uid("bsl"),
          `bug_${index + 1}`,
          svc,
          linkStatus
        );
      });
    });

    // Shared bug with one outstanding service link → stays Open overall.
    run(
      `INSERT INTO bugs (id, bug_key, title, severity, status, reported_date, reported_by, activity_id, notes, is_demo)
       VALUES ('bug_shared', 'HFM-1051', 'Shared calculation defect across Core and Web', 'Critical', 'Open', ?, 'p_sofia', 'act_001', 'Same defect ID linked to two services.', 1)`,
      d(-2)
    );
    run(
      `INSERT INTO bug_service_links (id, bug_id, service_id, status) VALUES (?, 'bug_shared', 'svc_core_calc', 'Closed')`,
      uid("bsl")
    );
    run(
      `INSERT INTO bug_service_links (id, bug_id, service_id, status) VALUES (?, 'bug_shared', 'svc_web_ui', 'Open')`,
      uid("bsl")
    );

    // ------------------------------------------------------------------ enhancements
    const enhancements: Array<[string, string, string, string, string, string]> = [
      [
        "Add department-level capacity forecasting",
        "Capacity is currently reviewed month by month; leadership needs a rolling three-month forecast per department to plan contractors.",
        "Forecast view, department filter, export to CSV, FTE + hours modes.",
        "Reporting, Capacity",
        "Three-month capacity forecast with contractor shortfall highlighted weekly.",
        "Forecast produced in under 5 seconds for 40 people and a 90-day window.",
      ],
      [
        "Two-way Teams notification for go/no-go decisions",
        "Release governance decisions are made in the app but the wider business still waits for an email.",
        "Teams webhook, opt-in per release, retry with audit trail, no secrets in client.",
        "Releases, Security",
        "Go/no-go decision posts to the release channel within a minute.",
        "100% of decisions delivered or queued; delivery failures visible in audit log.",
      ],
      [
        "Sticky note templates per department",
        "Each department wants its own AI guidance wording on shared tabs.",
        "Template CRUD, department-scoped overrides, fallback to global note.",
        "Master Setup",
        "Departments tailor guidance without forking the app.",
        "Note resolution tested for 3 departments; fallback verified.",
      ],
    ];
    enhancements.forEach(([title, brief, requirements, impacts, outcome, success], i) => {
      run(
        `INSERT INTO enhancements (id, ref, title, brief, requirements, impacts, expected_outcome, success_criteria, markdown, status, submitted_by, department_id, votes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        `enh_seed_${i + 1}`,
        `ENH-${String(i + 1).padStart(4, "0")}`,
        title,
        brief,
        requirements,
        impacts,
        outcome,
        success,
        `# ${title}\n\n## Brief\n${brief}\n\n## Requirements\n${requirements}\n\n## Impacts\n${impacts}\n\n## Expected outcome\n${outcome}\n\n## Success criteria\n${success}\n`,
        "Archived",
        i === 0 ? "p_lachlan" : i === 1 ? "p_grace" : "p_amara",
        i === 0 ? "dept_qa" : "dept_rel",
        i === 2 ? 4 : 1
      );
      // Every seeded proposal has been reviewed and archived, so the stored path
      // must be the archived one: the active vault holds no seeded documents.
      const vaultPath =
        i === 0
          ? "enhancements/archive/ENH-0001-department-level-capacity-forecasting.md"
          : i === 1
            ? "enhancements/archive/ENH-0002-teams-notification-go-no-go.md"
            : "enhancements/archive/ENH-0003-sticky-note-templates.md";
      run(`UPDATE enhancements SET github_path = ? WHERE id = ?`, vaultPath, `enh_seed_${i + 1}`);
      run(`UPDATE enhancements SET archived_at = datetime('now') WHERE id = ?`, `enh_seed_${i + 1}`);
    });

    // ------------------------------------------------------------------ changelog
    CHANGELOG_ENTRIES.forEach((entry) =>
      run(
        `INSERT INTO changelog (id, version, title, date, type, pr_number, summary, items, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        uid("cl"),
        entry.version,
        entry.title,
        d(entry.offset),
        entry.type,
        entry.pr,
        entry.summary,
        JSON.stringify(entry.items)
      )
    );

    run(
      `INSERT INTO audit_events (id, actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, 'p_amara', 'Amara Okafor', 'seed.demo_data', 'system', 'bootstrap', ?)`,
      uid("aud"),
      JSON.stringify({ note: "Synthetic demo dataset loaded (flagged is_demo).", fiscalYear: fyBounds.label })
    );
  });

  return true;
}

function colourForGroup(group: string): string {
  const map: Record<string, string> = {
    Regression: "#4f8cff",
    Automation: "#14b8a6",
    Performance: "#f59e0b",
    Security: "#ef4444",
    Integration: "#a855f7",
    UAT: "#22c55e",
  };
  return map[group] ?? "#4f8cff";
}

/**
 * Catalogue sync.
 *
 * Tabs, sections and their AI guidance live in code (TAB_CATALOGUE / AI_NOTES)
 * but are stored in the database so an administrator can disable or relabel
 * them. This runs on every boot so a new tab added by a later release appears
 * on existing installations without a destructive re-seed. Enabled flags are
 * never reset — an administrator's choice always wins.
 */
export function ensureCatalogue() {
  transaction(() => {
    for (const tab of TAB_CATALOGUE) {
      run(
        `INSERT INTO tabs (id, key, label, icon, href, description, group_name, enabled, sort_order, min_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key = excluded.key, label = excluded.label, icon = excluded.icon, href = excluded.href,
           description = excluded.description, group_name = excluded.group_name, sort_order = excluded.sort_order,
           min_role = excluded.min_role`,
        tab.id,
        tab.key,
        tab.label,
        tab.icon,
        tab.href,
        tab.description,
        tab.group_name,
        tab.sort,
        tab.min_role ?? "viewer"
      );
      tab.sections.forEach((section, index) => {
        run(
          `INSERT INTO sections (id, tab_id, label, description, enabled, sort_order) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             tab_id = excluded.tab_id, label = excluded.label, description = excluded.description,
             sort_order = excluded.sort_order`,
          section.id,
          tab.id,
          section.label,
          section.description,
          (index + 1) * 10
        );
      });
    }

    for (const [scope, content] of Object.entries(AI_NOTES)) {
      if (!content) continue;
      const tabId = scope.startsWith("sec.")
        ? TAB_CATALOGUE.find((t) => t.sections.some((s) => s.id === scope))?.id
        : scope;
      if (!tabId) continue;
      const sectionId = scope.startsWith("sec.") ? scope : null;
      const exists = get<{ id: string }>(
        `SELECT id FROM sticky_notes WHERE tab_id = ? AND section_id IS ? AND ai_generated = 1 LIMIT 1`,
        tabId,
        sectionId
      );
      if (exists) continue;
      run(
        `INSERT INTO sticky_notes (id, tab_id, section_id, title, content, colour, ai_generated, pinned, enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        uid("note"),
        tabId,
        sectionId,
        sectionId ? "AI guidance" : "AI guidance for this tab",
        content,
        "#eef2ff"
      );
    }

    for (const entry of CHANGELOG_ENTRIES) {
      const exists = get<{ id: string }>(`SELECT id FROM changelog WHERE version = ? LIMIT 1`, entry.version);
      if (exists) continue;
      run(
        `INSERT INTO changelog (id, version, title, date, type, pr_number, summary, items, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        uid("cl"),
        entry.version,
        entry.title,
        d(entry.offset),
        entry.type,
        entry.pr,
        entry.summary,
        JSON.stringify(entry.items)
      );
    }
  });
}

export function bootstrapDatabase() {
  const createdReference = ensureReference();
  ensureCatalogue();
  let createdDemo = false;
  if (process.env.SEED_DEMO_DATA !== "false") {
    createdDemo = seedDemoData();
  }
  return { createdReference, createdDemo };
}

export function counts() {
  return {
    people: get<{ n: number }>("SELECT COUNT(*) AS n FROM people")?.n ?? 0,
    activities: get<{ n: number }>("SELECT COUNT(*) AS n FROM activities")?.n ?? 0,
    pipeline: get<{ n: number }>("SELECT COUNT(*) AS n FROM recording_pipeline")?.n ?? 0,
    bugs: get<{ n: number }>("SELECT COUNT(*) AS n FROM bugs")?.n ?? 0,
    tabs: all("SELECT id, label, enabled FROM tabs ORDER BY sort_order"),
  };
}
