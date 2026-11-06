"use server";

import { revalidatePath } from "next/cache";
import { canEdit, getViewer } from "@/lib/access";
import { runImport, type ImportReport } from "@/lib/import";
import { recordAudit } from "@/lib/audit";

export type ImportState = { report?: ImportReport; error?: string };

export async function runImportAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return { error: "Read-only access." };

  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { error: "Paste the source rows (with a header line) or upload a file first." };

  const target = String(formData.get("target") ?? "activities") as "activities" | "pipeline";
  const mode = String(formData.get("mode") ?? "dry-run") as "dry-run" | "apply";

  try {
    const report = runImport({
      text,
      target,
      mode,
      filename: String(formData.get("filename") ?? "pasted-rows"),
      actorId: viewer.person.id,
    });
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: mode === "apply" ? "import.apply" : "import.dry_run",
      entity: "import_batch",
      entityId: report.batchId,
      meta: { target, total: report.total, inserted: report.inserted, updated: report.updated, errors: report.errors },
    });
    revalidatePath("/imports");
    revalidatePath("/validation");
    revalidatePath("/");
    return { report };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
