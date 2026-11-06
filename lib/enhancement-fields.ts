/**
 * Shared vocabulary for the enhancement studio.
 *
 * Kept free of database and server imports so the client component can use the
 * same field list and labels as the server-side drafting engine.
 */

export type SuggestionField =
  | "outcome"
  | "sections"
  | "title"
  | "brief"
  | "requirements"
  | "impacts"
  | "expectedOutcome"
  | "successCriteria"
  | "markdown";

/** Draftable fields in the order they appear in the form. */
export const SUGGESTION_FIELDS: SuggestionField[] = [
  "outcome",
  "sections",
  "title",
  "brief",
  "requirements",
  "impacts",
  "expectedOutcome",
  "successCriteria",
  "markdown",
];

export const FIELD_LABELS: Record<SuggestionField, string> = {
  outcome: "Outcome you want",
  sections: "Impacted tab / section IDs",
  title: "Title",
  brief: "Brief",
  requirements: "Requirements",
  impacts: "Impacts",
  expectedOutcome: "Expected outcome",
  successCriteria: "Success criteria",
  markdown: "Markdown handover",
};

/** Short fields can show their option text on the button; long ones cannot. */
export const SHORT_SUGGESTION_FIELDS: SuggestionField[] = ["outcome", "sections", "title"];
