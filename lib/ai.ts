import type { Viewer } from "./access";
import { capacityMonth } from "./capacity";
import { listActivities } from "./activities";
import { listBugs, bugTotals } from "./bugs";
import { listPipeline, pipelineStats } from "./pipeline";
import { isoToday, addDays, monthStart } from "./dates";

/**
 * Local, deterministic AI assistance.
 *
 * The app never sends operational data to a third party by default. Every
 * insight is computed from the same queries the UI uses and lists its evidence,
 * so a reviewer can audit any statement. Set AI_PROVIDER to plug a hosted model
 * in later (see docs/DECISIONS.md #12) — the interface below stays the same.
 */

export type Insight = {
  id: string;
  severity: "critical" | "warning" | "good" | "info";
  title: string;
  detail: string;
  evidence: string[];
  href?: string;
};

export function dashboardInsights(viewer: Viewer, monthKey?: string): Insight[] {
  const month = capacityMonth(viewer, monthKey);
  const activities = listActivities(viewer, { from: month.start, to: month.end }).filter((a) => a.active === 1);
  const pipeline = listPipeline(viewer);
  const stats = pipelineStats(pipeline);
  const bugs = listBugs(viewer);
  const totals = bugTotals(bugs);
  const insights: Insight[] = [];

  const over = month.people.filter((p) => p.utilisation > 100);
  if (over.length) {
    insights.push({
      id: "capacity.over",
      severity: "warning",
      title: `${over.length} ${over.length === 1 ? "person is" : "people are"} over occupied capacity`,
      detail: `${over.map((p) => p.name.split(" ")[0]).join(", ")} exceed 100% occupied hours this month. Move non-critical recordings or add capacity before committing new QA scope.`,
      evidence: over.map((p) => `${p.name}: ${p.occupied}h occupied of ${p.total_hours}h`),
      href: "/capacity",
    });
  }

  const under = month.people.filter((p) => p.total_hours > 0 && p.utilisation < 70);
  if (under.length >= 2) {
    insights.push({
      id: "capacity.spare",
      severity: "good",
      title: `${under.length} people have headroom this month`,
      detail: `Average utilisation for ${under.map((p) => p.name.split(" ")[0]).join(", ")} is below 70%. Good window to pull forward automation work or pipeline recordings.`,
      evidence: under.map((p) => `${p.name}: ${p.utilisation}% occupied`),
      href: "/capacity",
    });
  }

  const blocked = pipeline.filter((p) => p.current_status === "Blocked" && !p.is_test);
  if (blocked.length) {
    insights.push({
      id: "pipeline.blocked",
      severity: "critical",
      title: `${blocked.length} recording${blocked.length === 1 ? "" : "s"} blocked`,
      detail: "Blocked recordings reduce eligible recording days. Assign an owner and a date, or move the item out of the current window.",
      evidence: blocked.map((p) => `${p.activity}: ${p.blocker ?? "no reason recorded"}`),
      href: "/pipeline",
    });
  }

  if (stats.avgAutomation < 60 && stats.total > 0) {
    insights.push({
      id: "pipeline.automation",
      severity: "info",
      title: "Recording automation is below target",
      detail: `Automation averages ${stats.avgAutomation}% across ${stats.total} operational recordings. Consider pairing a QA engineer with the recording owner for one session per week.`,
      evidence: [`Eligible recording days this window: ${stats.eligible}`, `Days blocked by QA overlap: ${stats.blocked}`],
      href: "/pipeline",
    });
  }

  const stale = activities.filter((a) => a.status === "In Progress" && a.derived_progress < 25 && a.start_date && a.start_date < addDays(isoToday(), -7));
  if (stale.length) {
    insights.push({
      id: "activities.stalled",
      severity: "warning",
      title: `${stale.length} in-progress activit${stale.length === 1 ? "y" : "ies"} below 25% after a week`,
      detail: "These started more than a week ago with little recorded progress. Either update the evidence or re-plan the end date so the calendar stays honest.",
      evidence: stale.slice(0, 5).map((a) => `${a.activity}: ${a.derived_progress}%`),
      href: "/calendar",
    });
  }

  const unassigned = activities.filter((a) => !a.assignee_id);
  if (unassigned.length) {
    insights.push({
      id: "activities.unassigned",
      severity: "info",
      title: `${unassigned.length} active activit${unassigned.length === 1 ? "y has" : "ies have"} no owner`,
      detail: "Unassigned work is real work. Give each item an owner so FTE demand can be attributed.",
      evidence: unassigned.slice(0, 5).map((a) => `${a.activity}${a.scheduled ? "" : " (unscheduled)"}`),
      href: "/calendar",
    });
  }

  if (totals.outstanding > 0) {
    insights.push({
      id: "bugs.outstanding",
      severity: totals.outstanding > 4 ? "warning" : "info",
      title: `${totals.outstanding} defect${totals.outstanding === 1 ? "" : "s"} still outstanding`,
      detail: `Reported ${totals.reported}, fixed ${totals.fixed}, closed ${totals.closed}. Progress on linked activities is derived from these links — one outstanding service link keeps a shared bug open.`,
      evidence: bugs
        .filter((b) => b.derived_status === "Open")
        .slice(0, 4)
        .map((b) => `${b.bug_key}: ${b.title}`),
      href: "/reporting",
    });
  }

  const unscheduled = listActivities(viewer, { includeInactive: true }).filter((a) => a.active === 1 && !a.scheduled);
  if (unscheduled.length) {
    insights.push({
      id: "data.unscheduled",
      severity: "warning",
      title: `${unscheduled.length} record${unscheduled.length === 1 ? "" : "s"} can't be scheduled`,
      detail: "Missing or invalid dates keep these out of every calendar. Clear the Data Quality queue so month-end reporting is complete.",
      evidence: unscheduled.slice(0, 4).map((a) => a.activity),
      href: "/validation",
    });
  }

  if (!insights.length) {
    insights.push({
      id: "all.clear",
      severity: "good",
      title: "No risks detected for this month",
      detail: "Capacity, pipeline and defect signals are all within tolerance. Keep the calendars current.",
      evidence: [`Working days in scope: ${month.totals.working_days}`],
    });
  }
  return insights;
}

const KEYWORD_MAP: Array<{ test: RegExp; area: string; impact: string }> = [
  { test: /calendar|date|fiscal|month/i, area: "QA Calendar", impact: "Calendar rendering, fiscal selectors and date-only scheduling." },
  { test: /capacity|resource|hours|utilisation|utilization/i, area: "Capacity", impact: "Capacity planner, FTE projection and utilisation reporting." },
  { test: /pipeline|record|recording/i, area: "Pipeline", impact: "Recording pipeline, eligibility calculation and exclusions." },
  { test: /release|deploy|go\/?no|pqu|version/i, area: "Releases", impact: "Release feed, PQU trains and governance decisions." },
  { test: /bug|defect|report|progress|outstanding/i, area: "Reporting", impact: "Bug ledger, service links and completion progress." },
  { test: /department|team|org|hierarchy|manager|employee/i, area: "Master Setup", impact: "Organisation hierarchy, visibility rules and department toggles." },
  { test: /tab|section|note|sticky|guidance/i, area: "App configuration", impact: "Tab/section toggles, stable IDs and AI sticky notes." },
  { test: /import|excel|workbook|sheet|migration/i, area: "Import Centre", impact: "Import mapping, provenance and validation recovery." },
  { test: /teams|notif|email|alert|slack/i, area: "Integrations", impact: "Notification delivery, consent and audit trail." },
  { test: /export|csv|report|dashboard|chart/i, area: "Reporting", impact: "Exports, dashboards and management reporting." },
  { test: /ai|assistant|summar|predict/i, area: "AI assistance", impact: "Insight generation, privacy and model configuration." },
];

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type EnhancementDraft = {
  title: string;
  brief: string;
  requirements: string;
  impacts: string;
  expectedOutcome: string;
  successCriteria: string;
  provider: string;
};

/**
 * Draft an enhancement from free text / pasted markdown.
 * Deterministic heuristics — no data leaves the server.
 */
export function draftEnhancement(input: {
  raw: string;
  area?: string;
  outcome?: string;
  submittedBy?: string;
}): EnhancementDraft {
  const raw = (input.raw || "").trim();
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = (lines.find((l) => !l.startsWith("#")) ?? "Untitled enhancement").replace(/^[-*]\s*/, "");
  const plain = raw.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const parts = sentences(plain);

  const lower = `${raw} ${input.area ?? ""}`.toLowerCase();
  const matches = KEYWORD_MAP.filter((k) => k.test.test(lower));
  const areaLabel = input.area || matches[0]?.area || "QA Calendar";

  const imperative = parts.filter((s) =>
    /^(add|allow|enable|build|create|support|show|surface|integrate|make|provide|display|let|import|export|notify|replace)\b/i.test(s)
  );
  const modal = parts.filter((s) => /\b(should|must|need|needs|required|would like|want)\b/i.test(s));
  const requirementSource = [...new Set([...imperative, ...modal])].slice(0, 6);

  const titleWords = firstLine
    .replace(/^(please\s+)?(can we|could we|we need|i need|i want|add|allow)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .slice(0, 90);
  const title = titleWords.charAt(0).toUpperCase() + titleWords.slice(1);

  const brief = parts.slice(0, 3).join(" ") || "No description supplied — edit this brief before submitting.";

  const requirements = requirementSource.length
    ? requirementSource.map((s) => `- ${s.replace(/^[-*]\s*/, "")}`).join("\n")
    : [
        `- Define the user journey for ${areaLabel} and the roles allowed to use it.`,
        `- Persist all changes with an audit trail and provenance.`,
        `- Add validation, empty-state and error handling for the new flow.`,
        `- Cover it with unit + integration tests and record the change under What's New.`,
      ].join("\n");

  const impacts = (matches.length ? matches.map((m) => m.impact) : [`Touches ${areaLabel}; confirm which tabs and sections are affected.`])
    .map((i) => `- ${i}`)
    .join("\n");

  const expectedOutcome =
    input.outcome?.trim() ||
    `The ${areaLabel.toLowerCase()} workflow becomes self-service inside the app, removing spreadsheet hand-offs and giving managers a defensible, auditable view.`;

  const successCriteria = [
    `- Delivered behind the existing role model (viewer / editor / manager / exec / admin) with no data leakage.`,
    `- Verified for the current fiscal year with month-over-quarter and holiday behaviour intact.`,
    `- Documented in What's New with the affected tab and section IDs.`,
    `- Automated tests cover the happy path and the failure/recovery path.`,
  ].join("\n");

  return {
    title: title.slice(0, 120) || "Untitled enhancement",
    brief,
    requirements,
    impacts,
    expectedOutcome,
    successCriteria,
    provider: process.env.AI_PROVIDER || "local",
  };
}

export function suggestSectionNote(sectionId: string, viewer: Viewer): string {
  const month = capacityMonth(viewer);
  const stats = pipelineStats(listPipeline(viewer));
  const activities = listActivities(viewer, { from: month.start, to: month.end }).filter((a) => a.active === 1);
  const avg = activities.length
    ? Math.round(activities.reduce((s, a) => s + a.derived_progress, 0) / activities.length)
    : 0;
  const over = month.people.filter((p) => p.utilisation > 100).length;

  const notes: Record<string, string> = {
    "sec.dashboard.kpis": `AI guidance · ${activities.length} active activities in ${month.label} with ${month.totals.fte_demand} FTE demand against ${month.people.length} people. ${over ? `${over} over capacity.` : "Capacity is within tolerance."}`,
    "sec.dashboard.progress": `AI guidance · Average completion is ${avg}%. Anything below 25% after its start date is flagged on this tab.`,
    "sec.dashboard.capacity": `AI guidance · Occupied capacity is ${month.totals.utilisation}% of ${month.totals.total_hours}h. Occupied includes leave and DevOps time — it is not productive utilisation.`,
    "sec.calendar.grid": `AI guidance · Showing ${activities.length} active activities in ${month.label}. Click any block to open its planned vs actual dates.`,
    "sec.pipeline.availability": `AI guidance · ${stats.eligible} eligible recording days, ${stats.blocked} blocked by QA overlaps. TEST records (${stats.test}) are excluded from these numbers.`,
    "sec.capacity.grid": `AI guidance · ${month.people.length} people in scope, ${month.totals.working_days} working days. Edit hours inline; 4-hour and 7.6-hour days are both valid.`,
    "sec.reporting.bugs": "AI guidance · Overall bug status is derived from service links. One outstanding link keeps a shared bug open.",
    "sec.releases.pqu": "AI guidance · Parsed date ranges are flagged rather than corrected. Confirm chronology before publishing a train.",
    "sec.enhancements.intake": "AI guidance · Describe the problem and the outcome. The assistant fills the structure; you stay the author.",
  };
  return (
    notes[sectionId] ??
    `AI guidance · ${activities.length} active activities, ${month.totals.utilisation}% occupied capacity and ${stats.eligible} eligible recording days in ${month.label}.`
  );
}

export function summariseEnhancement(markdown: string): string {
  const plain = markdown.replace(/[#*_>`-]/g, " ").replace(/\s+/g, " ").trim();
  const first = sentences(plain).slice(0, 2).join(" ");
  return first.length > 240 ? `${first.slice(0, 237)}…` : first;
}

export function aiStatus() {
  return {
    provider: process.env.AI_PROVIDER || "local",
    model: process.env.AI_PROVIDER === "openai" ? "configured-remotely" : "deterministic-local-v1",
    note:
      (process.env.AI_PROVIDER || "local") === "local"
        ? "All insights are computed on this server from live records. No operational data leaves the instance."
        : "A hosted provider is configured. Review the data-handling decision before enabling it in production.",
    month: monthStart(isoToday()).slice(0, 7),
  };
}
