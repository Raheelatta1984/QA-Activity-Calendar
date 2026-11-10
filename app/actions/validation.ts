"use server";

import { revalidatePath } from "next/cache";
import { get, run } from "@/lib/db";
import { canEdit, getViewer } from "@/lib/access";
import { runValidation, validationSummary } from "@/lib/validation";
import { recordAudit } from "@/lib/audit";

export async function runValidationAction(): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const issues = runValidation(viewer.org.company.id);
  const summary = validationSummary(viewer.org.company.id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "validation.run",
    entity: "validation",
    meta: { issues, summary },
  });
  revalidatePath("/validation");
  revalidatePath("/");
  revalidatePath("/", "layout");
}

export async function setIssueStatusAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["open", "acknowledged", "resolved"].includes(status)) return;
  const issue = get<{ company_id: string | null }>(
    "SELECT company_id FROM validation_issues WHERE id = ?",
    id
  );
  if (!issue || (issue.company_id && issue.company_id !== viewer.org.company.id)) return;
  run(`UPDATE validation_issues SET status = ? WHERE id = ?`, status, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "validation.status",
    entity: "validation_issue",
    entityId: id,
    after: status,
  });
  revalidatePath("/validation");
  revalidatePath("/");
  revalidatePath("/", "layout");
}
