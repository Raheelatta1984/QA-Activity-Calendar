/**
 * Enhancement lifecycle — ported verbatim in spirit from the source app's
 * `lib/enhancement-status.ts`. Pure TypeScript: no database, no filesystem, no
 * framework imports, so the UI, the REST API, the MCP tools and the host
 * application all agree on what a status means.
 */

export const ENHANCEMENT_STATUSES = [
  "Submitted",
  "Reviewing",
  "Accepted",
  "Building",
  "Built",
  "Archived",
  "Rejected",
] as const;

export type EnhancementStatus = (typeof ENHANCEMENT_STATUSES)[number];

/** Statuses that mean "a Markdown handover exists in the target repository". */
export const HANDOVER_STATUSES: EnhancementStatus[] = ["Building", "Built"];

export const STATUS_LABELS: Record<string, string> = {
  Submitted: "Submitted",
  Reviewing: "In review",
  Accepted: "Accepted",
  Building: "Building — handover published",
  Built: "Built — awaiting archive",
  Archived: "Archived",
  Rejected: "Rejected",
};

export const STATUS_HINTS: Record<string, string> = {
  Submitted: "Awaiting triage. The drafting engine structured the request; every field stays editable.",
  Reviewing: "Being assessed. Move to Accepted once outcome and success criteria are agreed.",
  Accepted: "Approved for delivery. Move to Building to publish the Markdown handover to the connected repository.",
  Building: "Handover published to the application's vault. A development request has been raised.",
  Built: "The implementation PR merged. The completion automation archives the handover and closes the request.",
  Archived: "Moved to the archive. It is never reviewed twice.",
  Rejected: "Not proceeding. Kept for the record so the same request is not re-raised blindly.",
};

export function isEnhancementStatus(value: unknown): value is EnhancementStatus {
  return typeof value === "string" && (ENHANCEMENT_STATUSES as readonly string[]).includes(value);
}

/** True while the proposal should have a Building/Built Markdown file in the repo. */
export function hasHandover(status: string | null | undefined): boolean {
  return HANDOVER_STATUSES.includes((status ?? "") as EnhancementStatus);
}

export function statusAfterPublish(status: string): EnhancementStatus {
  return hasHandover(status) ? (status as EnhancementStatus) : "Building";
}

/**
 * When the Markdown file has moved into the archive, the database status must
 * follow. Any pre-archive status becomes Archived; Rejected and already
 * Archived records are left untouched so a deliberate decision is never
 * overwritten.
 */
export function statusAfterArchive(status: string): EnhancementStatus {
  if (status === "Rejected" || status === "Archived") return status === "Rejected" ? "Rejected" : "Archived";
  return "Archived";
}

export function isArchivedStatus(status: string): boolean {
  return status === "Archived" || status === "Rejected";
}

/** Ordered pipeline stages (Archived/Rejected are terminal). */
export function pipelineStages(): EnhancementStatus[] {
  return ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived"];
}

/** Allowed manual transitions. Rejected can be reopened to Reviewing. */
export function canTransition(from: string, to: string): boolean {
  if (!isEnhancementStatus(from) || !isEnhancementStatus(to)) return false;
  if (from === to) return false;
  if (from === "Rejected") return to === "Reviewing";
  if (from === "Archived") return to === "Reviewing";
  return true;
}
