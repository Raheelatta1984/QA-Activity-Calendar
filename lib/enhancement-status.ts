/**
 * Enhancement lifecycle shared by the app and the repository automation.
 *
 * The vault Markdown carries the status. A handover is *published* to
 * `lib/future-enhancements/` while it is **Building**, stays there as **Built**
 * once the code is merged, and is moved to `lib/future-enhancements/archived/`
 * with the status **Archived** after the completion automation runs. Keeping the
 * mapping in one pure module means the UI, the bootstrap sync and the tests all
 * agree about what a status means.
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

/** Two statuses mean "a Markdown handover exists in the repository". */
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
  Submitted: "Awaiting triage. The assistant drafted the structure; every field stays editable.",
  Reviewing: "Being assessed. Move to Accepted when the outcome and success criteria are agreed.",
  Accepted: "Approved for delivery. Move to Building to publish the Markdown handover to GitHub.",
  Building: "Handover published to lib/future-enhancements/. An Arena development request has been raised.",
  Built: "The implementation PR merged. The completion automation archives the handover and closes the request.",
  Archived: "Moved to lib/future-enhancements/archived/. It is never reviewed twice.",
  Rejected: "Not proceeding. Kept for the record so the same request is not re-raised blindly.",
};

export function isEnhancementStatus(value: unknown): value is EnhancementStatus {
  return typeof value === "string" && (ENHANCEMENT_STATUSES as readonly string[]).includes(value);
}

/** True while the proposal should have a Building/Built Markdown file in the repo. */
export function hasHandover(status: string | null | undefined): boolean {
  return HANDOVER_STATUSES.includes((status ?? "") as EnhancementStatus);
}

/**
 * A published handover stays "Building" until the code exists; **Built** is the
 * status a reviewer sets (or the app syncs) once the implementation has merged,
 * immediately before the completion automation archives it.
 */
export function statusAfterPublish(status: string): EnhancementStatus {
  return hasHandover(status) ? (status as EnhancementStatus) : "Building";
}

/**
 * When the Markdown file has moved into `archived/`, the database status must
 * follow. Any pre-archive status becomes Archived; Rejected and already Archived
 * records are left untouched so a deliberate decision is never overwritten.
 */
export function statusAfterArchive(status: string): EnhancementStatus {
  if (status === "Rejected" || status === "Archived") return status === "Rejected" ? "Rejected" : "Archived";
  return "Archived";
}

export function isArchivedStatus(status: string): boolean {
  return status === "Archived" || status === "Rejected";
}

/** Ordered stages used by the pipeline badges (Archived/Rejected are terminal). */
export function pipelineStages(): EnhancementStatus[] {
  return ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived"];
}
