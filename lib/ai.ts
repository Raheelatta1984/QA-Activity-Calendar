import type { Viewer } from "./access";
import { capacityMonth } from "./capacity";
import { listActivities } from "./activities";
import { listBugs, bugTotals } from "./bugs";
import { listPipeline, pipelineStats } from "./pipeline";
import { isoToday, addDays, monthStart } from "./dates";
import type { SuggestionField } from "./enhancement-fields";

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
  {
    test: /\bfte\b|full.?time equivalent|headcount|resourcing|resource planning|capacity calendar/i,
    area: "FTE Calendar",
    impact: "FTE calendar grid, activity × day totals, resourcing summary and the FTE/hours toggle.",
  },
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

/* -------------------------------------------------------------------------- */
/* Live field suggestions for the enhancement studio                           */
/* -------------------------------------------------------------------------- */

export type EnhancementSuggestions = Record<SuggestionField, string[]> & {
  provider: string;
  area: string;
  generatedAt: string;
};

export type SectionRef = { id: string; label: string; tabId: string; tabLabel: string };

export type SuggestionInput = {
  raw: string;
  area?: string;
  outcome?: string;
  title?: string;
  brief?: string;
  requirements?: string;
  impacts?: string;
  expectedOutcome?: string;
  successCriteria?: string;
  sections?: string;
  departmentName?: string;
  submittedBy?: string;
  /** Live tab/section catalogue from the database (supplied by the action). */
  catalogue?: SectionRef[];
};

/** Ranks real tab/section IDs against the request text so suggestions are valid IDs. */
export function matchSections(text: string, area: string | undefined, catalogue: SectionRef[]): SectionRef[] {
  if (!catalogue.length) return [];
  const words = new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  const areaLower = (area ?? "").toLowerCase();
  return catalogue
    .map((entry) => {
      const haystack = `${entry.id} ${entry.label} ${entry.tabId} ${entry.tabLabel}`.toLowerCase();
      let score = 0;
      for (const word of words) if (haystack.includes(word)) score += 2;
      if (areaLower && haystack.includes(areaLower)) score += 5;
      if (areaLower && haystack.includes(areaLower.replace(/\s+/g, ""))) score += 3;
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map((row) => row.entry);
}

function unique(list: string[]): string[] {
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

const DANGLING = /\s+(a|an|the|and|or|so|as|per|for|to|of|with|by|in|on|we|i|that|can|should|must|from|at|is|are|be)$/i;

/** Shortens to a word boundary without an ellipsis — for sentences that read on. */
function trimWords(value: string, max: number) {
  let text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  text = text.slice(0, max);
  const space = text.lastIndexOf(" ");
  if (space > max * 0.6) text = text.slice(0, space);
  while (DANGLING.test(text)) text = text.replace(DANGLING, "");
  return `${text.trimEnd()},`;
}

/** Clips on a word boundary and never leaves a dangling conjunction behind. */
function clip(value: string, max: number) {
  let text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  text = text.slice(0, max);
  const space = text.lastIndexOf(" ");
  if (space > max * 0.6) text = text.slice(0, space);
  text = text.replace(/[,;:.-]+$/, "");
  while (DANGLING.test(text)) text = text.replace(DANGLING, "");
  return `${text.trimEnd()}…`;
}

function firstSentence(value: string) {
  return sentences(value.replace(/\s+/g, " "))[0] ?? value.trim();
}

/** Splits a request into the thing asked for and the reason it is wanted. */
function splitRequest(raw: string): { subject: string; purpose: string } {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const first = (lines.find((l) => !l.startsWith("#")) ?? "").replace(/^[-*]\s*/, "").replace(/^#+\s*/, "");
  const marker = first.search(/\s+(so that|so we can|so i can|so you can|so they can|in order to|to be able to|because)\b/i);
  const head = marker > 0 ? first.slice(0, marker) : first;
  const tail = marker > 0 ? first.slice(marker).replace(/^\s*(so that|so we can|so i can|so you can|so they can|in order to|to be able to|because)\s+/i, "") : "";

  const subject = clip(
    head
      .replace(
        /^(please\s+)?(can|could|would)\s+(we|you|i)\s+(please\s+)?(add|create|build|get|have|need|want|like|see)?\s*/i,
        ""
      )
      .replace(/^(please\s+)?(we|i)\s+(need|want|would like|require|must|should)\s+(to\s+)?(add|create|build|have|get|see|be able to)?\s*/i, "")
      .replace(/^(please\s+)?(add|create|build|allow|enable|show|give|provide|let|display|import|export|track|plan|forecast)\s+/i, "$2 ")
      .replace(/^(a|an|the)\s+/i, "$1 ")
      .replace(/[.!?,;:]+$/, "")
      .trim(),
    90
  );
  const purpose = clip(tail.replace(/[.!?]+$/, "").trim(), 140);
  return { subject: subject || "this change", purpose };
}

/** The thing being asked for, with leading request phrasing removed. */
function subjectOf(raw: string): string {
  return splitRequest(raw).subject;
}

/** Turns the "so that …" clause into a verb phrase, e.g. "review and arrange resources". */
function purposeOf(raw: string): string {
  const purpose = splitRequest(raw).purpose;
  if (!purpose) return "";
  return purpose.replace(/^(we|i|you|they)\s+(can|could|would|need to|want to)\s+/i, "").trim();
}

/**
 * Produces 1–3 candidate values for every field the studio can draft.
 *
 * Deliberately deterministic and local: no operational data leaves the server
 * (see docs/DECISIONS.md #12). Suggestions are *options* — the author accepts,
 * edits or ignores each one, and any manual edit wins from that point on.
 */
export function suggestEnhancementFields(input: SuggestionInput): EnhancementSuggestions {
  const raw = (input.raw || "").trim();
  const plain = raw.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const parts = sentences(plain);
  const lower = `${raw} ${input.area ?? ""}`.toLowerCase();
  const matches = KEYWORD_MAP.filter((k) => k.test.test(lower));
  const areaLabel = input.area || matches[0]?.area || "QA Calendar";
  const { subject: rawSubject, purpose } = splitRequest(raw);
  const subject = rawSubject || "this change";
  const shortSubject = clip(subject, 70);
  const reason = purposeOf(raw);
  const audience = /manager|head of|lead/i.test(raw)
    ? "Managers"
    : /admin/i.test(raw)
      ? "Administrators"
      : /exec|coo|director/i.test(raw)
        ? "Executives"
        : "The QA team";

  const imperative = parts.filter((s) =>
    /^(add|allow|enable|build|create|support|show|surface|integrate|make|provide|display|let|import|export|notify|replace|give|track|plan|forecast|schedule)\b/i.test(
      s
    )
  );
  const modal = parts.filter((s) => /\b(should|must|need|needs|required|would like|want)\b/i.test(s));
  const requirementSource = [...new Set([...imperative, ...modal])].slice(0, 6);

  const outcomeClause =
    input.outcome?.trim() ||
    (reason ? `${reason}` : "") ||
    `keep ${areaLabel.toLowerCase()} current without a spreadsheet hand-off`;

  // ---- title ---------------------------------------------------------------
  const titleBase = subject.charAt(0).toUpperCase() + subject.slice(1);
  const titles = unique([
    clip(titleBase, 110),
    clip(`${areaLabel} — ${shortSubject}`, 110),
    ...(reason ? [clip(`${titleBase} so we can ${trimWords(reason, 60)}`, 110)] : []),
  ]);

  // ---- brief ---------------------------------------------------------------
  const role = audience === "The QA team" ? "a QA engineer" : `a ${audience.toLowerCase().replace(/s$/, "")}`;
  const briefs = unique([
    clip(parts.slice(0, 2).join(" ") || `Improve ${areaLabel.toLowerCase()}: ${subject}.`, 420),
    clip(`As ${role}, I want ${subject} so I can ${reason || outcomeClause}.`, 420),
    clip(`${titleBase}. Raised against ${areaLabel}${input.departmentName ? ` for ${input.departmentName}` : ""}.`, 420),
  ]);

  // ---- requirements --------------------------------------------------------
  // Start from the request itself, then fall back to the house baseline.
  const requested = [...new Set([...imperative, ...modal])]
    .map((sentence) => sentence.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim())
    .map((sentence) => (sentence.endsWith(".") ? sentence : `${sentence}.`))
    .filter((sentence) => !new RegExp(`^${subject.slice(0, 24)}`, "i").test(sentence) || sentence.length < 120);
  const derived = [`- Deliver ${subject}.`];
  if (reason) derived.push(`- ${audience} must be able to ${reason}.`);
  const functional = [...new Set([...derived, ...requested.map((item) => `- ${item}`)])].slice(0, 5).join("\n");
  const nonFunctional = [
    `- Roles: available to editor and above; read-only for viewer, holistic for exec/admin.`,
    `- Data: reuse the existing tables and migration path — no parallel spreadsheet.`,
    `- Audit: every write records actor, before/after and the stable tab/section ID.`,
    `- Validation: new rules land in the Data Quality catalogue with a severity.`,
    `- Performance: the view must render for a full fiscal month in under a second.`,
  ].join("\n");
  const prioritised = [
    `**Must**\n${derived.map((item) => (item.endsWith(".") ? item : `${item}.`)).join("\n")}`,
    `**Should**\n${requested
      .slice(0, 2)
      .map((s) => `- ${s.replace(/^[-*]\s*/, "")}`)
      .join("\n") || `- Keep the existing behaviour as the default until the change is accepted.`}`,
    `**Could**\n- Surface the same figure on the dashboard once the base view is stable.`,
  ].join("\n\n");
  const requirements = unique([functional, nonFunctional, prioritised]);

  // ---- impacts -------------------------------------------------------------
  const systemImpacts = (matches.length ? matches.map((m) => m.impact) : [`Touches ${areaLabel}; confirm which tabs and sections are affected.`])
    .map((i) => `- ${i}`)
    .join("\n");
  const peopleImpacts = [
    `- People: ${audience} change how they prepare the monthly view — sticky-note guidance must be re-drafted.`,
    `- Process: the step this replaces should be removed from the workbook so there is one source of truth.`,
    `- Training: add a What's New entry naming the affected tab and section IDs.`,
  ].join("\n");
  const dataImpacts = [
    `- Reporting: figures derived from this area must stay traceable to the source record.`,
    `- Capacity / FTE: if the change alters scheduled work, re-check the FTE calendar for the affected month.`,
    `- Integrations: exports or notifications that read this area need the same rule applied.`,
  ].join("\n");
  const impacts = unique([systemImpacts, peopleImpacts, dataImpacts]);

  // ---- expected outcome ----------------------------------------------------
  const expectedOutcome = unique([
    input.outcome?.trim() || "",
    `${titleBase} is available inside the app${reason ? `, so ${audience.charAt(0).toLowerCase()}${audience.slice(1)} can ${clip(reason, 110)}` : ""} without a spreadsheet hand-off and with an audit trail behind every figure.`,
    `${areaLabel} decisions are made from live data: every number can be traced to the record it came from, for ${input.departmentName ?? "the department"}.`,
  ]);

  // ---- success criteria ----------------------------------------------------
  const deliveryCriteria = [
    `- Delivered behind the existing role model (viewer / editor / manager / exec / admin) with no data leakage.`,
    `- Verified for the current fiscal year with month-over-quarter and holiday behaviour intact.`,
    `- Documented in What's New with the affected tab and section IDs.`,
    `- Automated tests cover the happy path and the failure/recovery path.`,
  ].join("\n");
  const measurableCriteria = [
    `- The new behaviour is used for two consecutive monthly planning cycles without a manual workaround.`,
    `- Every figure shown is reproducible from the source records by a reviewer.`,
    `- No new row enters the Data Quality queue as a result of the change.`,
  ].join("\n");
  const operationalCriteria = [
    `- Sticky-note guidance on each affected section is re-drafted and dated.`,
    `- The affected tab/section IDs are listed on the proposal and unchanged after delivery.`,
    `- A reviewer other than the author can complete the flow unaided.`,
  ].join("\n");
  const successCriteria = unique([deliveryCriteria, measurableCriteria, operationalCriteria]);

  // ---- outcome hint (the "outcome you want" field) -------------------------
  const outcomes = unique([
    input.outcome?.trim() || "",
    `${audience} can see ${subject} without leaving the app.`,
    ...(reason ? [`${audience} can ${trimWords(reason, 70)} from live data.`] : []),
    `${areaLabel} is planned from live data instead of a copied spreadsheet.`,
  ]);

  // ---- impacted tab / section IDs ------------------------------------------
  const ranked = matchSections(raw, input.area, input.catalogue ?? []);
  const sectionOptions = unique([
    ranked.slice(0, 1).map((r) => r.id).join(", "),
    ranked.slice(0, 2).map((r) => r.id).join(", "),
    ranked.slice(0, 3).map((r) => r.id).join(", "),
  ]);

  // ---- markdown handover ---------------------------------------------------
  const markdown = unique([
    buildHandover({
      title: input.title?.trim() || titles[0],
      brief: input.brief?.trim() || briefs[0],
      requirements: input.requirements?.trim() || requirements[0],
      impacts: input.impacts?.trim() || impacts[0],
      expectedOutcome: input.expectedOutcome?.trim() || expectedOutcome[0],
      successCriteria: input.successCriteria?.trim() || successCriteria[0],
      sections: input.sections?.trim() || sectionOptions[0],
      raw,
      areaLabel,
      submittedBy: input.submittedBy,
    }),
  ]);

  return {
    outcome: outcomes,
    sections: sectionOptions,
    title: titles,
    brief: briefs,
    requirements,
    impacts,
    expectedOutcome,
    successCriteria,
    markdown,
    provider: process.env.AI_PROVIDER || "local",
    area: areaLabel,
    generatedAt: new Date().toISOString(),
  };
}

/** The markdown handover draft shown (and editable) in the studio. */
export function buildHandover(input: {
  title: string;
  brief: string;
  requirements: string;
  impacts: string;
  expectedOutcome: string;
  successCriteria: string;
  sections?: string;
  raw?: string;
  areaLabel?: string;
  submittedBy?: string;
}): string {
  return [
    `# ${input.title || "Untitled enhancement"}`,
    "",
    "## What needs to change",
    input.raw?.trim() || input.brief || "_Describe the problem in the studio before exporting._",
    "",
    "## Brief",
    input.brief || "_To be confirmed_",
    "",
    "## Requirements",
    input.requirements || "_To be confirmed_",
    "",
    "## Impacts",
    input.impacts || "_To be confirmed_",
    "",
    "## Expected outcome",
    input.expectedOutcome || "_To be confirmed_",
    "",
    "## Success criteria",
    input.successCriteria || "_To be confirmed_",
    "",
    input.sections ? `**Affected IDs:** ${input.sections}\n` : "",
    input.areaLabel ? `_Area: ${input.areaLabel}${input.submittedBy ? ` · raised by ${input.submittedBy}` : ""}_\n` : "",
    "_Drafted by the HFM QA Calendar assistant. Review and edit every section before submitting._",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    "sec.fte.filters": `AI guidance · Scope defaults to the QA department with recording rows excluded. Quarter view is useful for contractor planning; month view is for the stand-up.`,
    "sec.fte.summary": `AI guidance · Demand is ${month.totals.fte_demand} FTE against ${month.people.length} people in ${month.label}. A negative gap is a request for people, not a performance signal.`,
    "sec.fte.grid": `AI guidance · Read the daily total row first. Anything above the team headcount needs a decision before the month starts; idle days are where pulled-forward work goes.`,
    "sec.fte.resources": `AI guidance · Variance is measured against 1.0 FTE per person. Someone over 1.0 on several days is the first conversation when re-sequencing.`,
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
