/**
 * Local, deterministic drafting engine — ported from the source app's
 * `lib/ai.ts` (the `draftEnhancement` / `suggestEnhancementFields` slice) and
 * generalised: nothing here is QA-Calendar-specific any more. The application
 * name comes from the connected application record, not a hardcoded vocabulary.
 *
 * No data leaves the process. Every value is derived from the author's own
 * words with an auditable rule, and `provider` states where each draft came
 * from. Set AI_PROVIDER and swap these functions for a hosted model later —
 * the return shapes stay the same.
 */

export type EnhancementDraft = {
  title: string;
  brief: string;
  requirements: string;
  impacts: string;
  expectedOutcome: string;
  successCriteria: string;
  provider: string;
};

export type SuggestionField =
  | "outcome"
  | "title"
  | "brief"
  | "requirements"
  | "impacts"
  | "expectedOutcome"
  | "successCriteria"
  | "markdown";

export type EnhancementSuggestions = Partial<Record<SuggestionField, string[]>> & { provider: string };

export type SuggestionInput = {
  raw: string;
  applicationName?: string;
  outcome?: string;
  title?: string;
  brief?: string;
  requirements?: string;
  impacts?: string;
  expectedOutcome?: string;
  successCriteria?: string;
  submittedBy?: string;
  departmentName?: string;
};

/** Only suggest a field the author has not already written meaningfully. */
function untouched(value: string | undefined, min = 4): boolean {
  return !value || value.trim().length < min;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).replace(/[\s,;:.-]+$/, "")}…`;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (value.trim() && !seen.has(key)) {
      seen.add(key);
      out.push(value.trim());
    }
  }
  return out;
}

function trimWords(value: string, maxChars: number): string {
  return clip(value, maxChars);
}

/** "…so that X" / "…so we can X" / "in order to X" → the purpose clause. */
function purposeOf(raw: string): string {
  const match = raw.match(/\bso (?:that |we can |i can )(.+?)[.!?\n]|(?:\bin order to |to )(.+?)[.!?\n]/i);
  const purpose = (match?.[1] ?? match?.[2] ?? "").trim();
  return purpose.replace(/^(?:the |a |an )?/i, "").replace(/[.!?,;]+$/, "");
}

/** "Can we add X", "Please build X" → the subject being requested. */
function splitRequest(raw: string): { subject: string; purpose: string } {
  const first = sentences(raw)[0] ?? raw;
  const subject = first
    .replace(/^(?:hey|hi|hello)[,!\s]+/i, "")
    .replace(/^(?:please\s+)?(?:can we |could we |we need |i need |i want |we should |i would like )(?:to )?/i, "")
    .replace(/^(?:add|allow|enable|build|create|support|show|surface|integrate|make|provide|display|give|track|plan|forecast|schedule)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  return { subject: subject || first.replace(/[.!?]+$/, ""), purpose: purposeOf(raw) };
}

function imperativeSentences(parts: string[]): string[] {
  return parts.filter((s) =>
    /^(add|allow|enable|build|create|support|show|surface|integrate|make|provide|display|let|import|export|notify|replace|give|track|plan|forecast|schedule)\b/i.test(s)
  );
}

function modalSentences(parts: string[]): string[] {
  return parts.filter((s) => /\b(should|must|need|needs|required|would like|want)\b/i.test(s));
}

function baselineRequirements(area: string): string[] {
  return [
    `- Define the user journey for ${area} and the roles allowed to use it.`,
    "- Persist all changes with an audit trail and provenance.",
    "- Add validation, empty-state and error handling for the new flow.",
    "- Cover it with unit + integration tests and record the change in the host project's changelog.",
  ];
}

function baselineSuccessCriteria(): string {
  return [
    "- Delivered behind the host application's role model with no data leakage.",
    "- Automated tests cover the happy path and the failure/recovery path.",
    "- Documented with the affected areas / section IDs.",
    "- A reviewer other than the author can complete the flow unaided.",
  ].join("\n");
}

export function draftEnhancement(input: {
  raw: string;
  applicationName?: string;
  outcome?: string;
  submittedBy?: string;
}): EnhancementDraft {
  const raw = (input.raw || "").trim();
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = (lines.find((l) => !l.startsWith("#")) ?? "Untitled enhancement").replace(/^[-*]\s*/, "");
  const plain = raw.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const parts = sentences(plain);
  const area = input.applicationName || "the application";

  const imperative = imperativeSentences(parts);
  const modal = modalSentences(parts);
  const requirementSource = [...new Set([...imperative, ...modal])].slice(0, 6);

  const titleWords = firstLine
    .replace(/^(please\s+)?(can we|could we|we need|i need|i want|add|allow)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .slice(0, 90);
  const title = titleWords.charAt(0).toUpperCase() + titleWords.slice(1);

  const brief = parts.slice(0, 3).join(" ") || "No description supplied — edit this brief before submitting.";

  const requirements = requirementSource.length
    ? requirementSource.map((s) => `- ${s.replace(/^[-*]\s*/, "")}`).join("\n")
    : baselineRequirements(area).join("\n");

  const impacts = `- Touches ${area}; confirm which tabs and sections are affected.`;

  const expectedOutcome =
    input.outcome?.trim() ||
    `The ${area} workflow becomes self-service, removing manual hand-offs and giving reviewers a defensible, auditable view.`;

  return {
    title: title.slice(0, 120) || "Untitled enhancement",
    brief,
    requirements,
    impacts,
    expectedOutcome,
    successCriteria: baselineSuccessCriteria(),
    provider: process.env.AI_PROVIDER || "local",
  };
}

export function suggestEnhancementFields(input: SuggestionInput): EnhancementSuggestions {
  const raw = (input.raw || "").trim();
  const plain = raw.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const parts = sentences(plain);
  const area = input.applicationName || "the application";
  const { subject, purpose } = splitRequest(raw);
  const reason = purposeOf(raw);
  const audience = /manager|head of|lead/i.test(raw)
    ? "Managers"
    : /admin/i.test(raw)
      ? "Administrators"
      : /exec|coo|director/i.test(raw)
        ? "Executives"
        : "The team";

  const requirementSource = [...new Set([...imperativeSentences(parts), ...modalSentences(parts)])]
    .slice(0, 6)
    .map((sentence) => sentence.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim())
    .map((sentence) => (sentence.endsWith(".") ? sentence : `${sentence}.`));

  const outcomeClause = input.outcome?.trim() || reason || `keep ${area} current without a manual hand-off`;
  const titleBase = subject.charAt(0).toUpperCase() + subject.slice(1);
  const role = audience === "The team" ? "a team member" : `a ${audience.toLowerCase().replace(/s$/, "")}`;
  const provider = process.env.AI_PROVIDER || "local";
  const suggestions: EnhancementSuggestions = { provider };

  if (untouched(input.title)) {
    suggestions.title = unique([
      clip(titleBase, 110),
      clip(`${area} — ${clip(subject, 70)}`, 110),
      ...(reason ? [clip(`${titleBase} so we can ${trimWords(reason, 60)}`, 110)] : []),
    ]);
  }

  if (untouched(input.brief)) {
    suggestions.brief = unique([
      clip(parts.slice(0, 2).join(" ") || `Improve ${area}: ${subject}.`, 420),
      clip(`As ${role}, I want ${subject} so I can ${reason || outcomeClause}.`, 420),
      clip(`${titleBase}. Raised against ${area}${input.departmentName ? ` for ${input.departmentName}` : ""}.`, 420),
    ]);
  }

  if (untouched(input.requirements)) {
    const derived = [`- Deliver ${subject}.`];
    if (reason) derived.push(`- ${audience} must be able to ${reason}.`);
    suggestions.requirements = unique([
      [...derived, ...requirementSource.map((item) => `- ${item}`)].slice(0, 6).join("\n"),
      baselineRequirements(area).join("\n"),
    ]);
  }

  if (untouched(input.impacts)) {
    suggestions.impacts = unique([
      `- System: touches ${area}; confirm which tabs and sections are affected.`,
      `- People: ${audience} change how they work in ${area} — guidance and training notes need updating.`,
      `- Reporting: figures derived from this area must stay traceable to the source record.`,
    ]);
  }

  if (untouched(input.expectedOutcome)) {
    suggestions.expectedOutcome = unique([
      input.outcome?.trim() || "",
      `${titleBase} is available inside the app${
        reason ? `, so ${audience.charAt(0).toLowerCase()}${audience.slice(1)} can ${clip(reason, 110)}` : ""
      } without a manual hand-off and with an audit trail behind every change.`,
      `${area} decisions are made from live data: every number can be traced to the record it came from.`,
    ]);
  }

  if (untouched(input.successCriteria)) {
    suggestions.successCriteria = unique([
      baselineSuccessCriteria(),
      [
        "- The new behaviour is used for two consecutive planning cycles without a manual workaround.",
        "- Every figure shown is reproducible from the source records by a reviewer.",
      ].join("\n"),
    ]);
  }

  if (suggestions.expectedOutcome) {
    suggestions.outcome = unique([
      input.outcome?.trim() || "",
      `${audience} can see ${subject} without leaving the app.`,
      ...(reason ? [`${audience} can ${trimWords(reason, 70)} from live data.`] : []),
    ]);
  }

  return suggestions;
}

/** Render the Markdown handover from a suggestion pass, for live preview. */
export function buildHandoverPreview(input: SuggestionInput & { ref?: string }): string {
  const draft = draftEnhancement(input);
  return [
    `# ${input.title?.trim() || draft.title}`,
    "",
    "## Brief",
    input.brief?.trim() || draft.brief,
    "",
    "## Requirements",
    input.requirements?.trim() || draft.requirements,
    "",
    "## Expected outcome",
    input.expectedOutcome?.trim() || draft.expectedOutcome,
    "",
    "## Success criteria",
    input.successCriteria?.trim() || draft.successCriteria,
    "",
  ].join("\n");
}
