"use server";

import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { canAdmin, getViewer } from "@/lib/access";
import { uid } from "@/lib/ids";
import { isIsoDate, isoToday } from "@/lib/dates";
import { recordAudit } from "@/lib/audit";

export async function saveChangelogAction(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!canAdmin(viewer)) return;
  const version = String(formData.get("version") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!version || !title) return;
  const date = String(formData.get("date") ?? "");
  const items = String(formData.get("items") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ label, detail: "" }));
  const prNumber = Number(formData.get("pr_number") ?? 0) || null;

  run(
    `INSERT INTO changelog (id, version, title, date, type, pr_number, pr_url, summary, items, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    uid("cl"),
    version,
    title,
    isIsoDate(date) ? date : isoToday(),
    String(formData.get("type") ?? "feature"),
    prNumber,
    String(formData.get("pr_url") ?? "") || null,
    String(formData.get("summary") ?? "") || null,
    JSON.stringify(items)
  );
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "changelog.create",
    entity: "changelog",
    after: { version, title, prNumber },
  });
  revalidatePath("/changelog");
  revalidatePath("/", "layout");
}
