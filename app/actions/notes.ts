"use server";

import { revalidatePath } from "next/cache";
import { all, get, run } from "@/lib/db";
import { getViewer, canEdit } from "@/lib/access";
import { uid } from "@/lib/ids";
import { recordAudit } from "@/lib/audit";
import { suggestSectionNote } from "@/lib/ai";

export async function saveNoteAction(formData: FormData) {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const path = String(formData.get("path") ?? "/");
  const id = String(formData.get("id") ?? "");
  const tabId = String(formData.get("tabId") ?? "");
  const sectionId = String(formData.get("sectionId") ?? "");
  const content = String(formData.get("content") ?? "").trim();
  const title = String(formData.get("title") ?? "AI guidance").trim() || "AI guidance";
  if (!content) return;

  if (id) {
    const before = get<any>("SELECT * FROM sticky_notes WHERE id = ?", id);
    run(`UPDATE sticky_notes SET content = ?, title = ?, updated_at = datetime('now') WHERE id = ?`, content, title, id);
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "note.update",
      entity: "sticky_note",
      entityId: id,
      before: before?.content,
      after: content,
    });
  } else {
    const noteId = uid("note");
    run(
      `INSERT INTO sticky_notes (id, tab_id, section_id, title, content, colour, author_id, updated_at)
       VALUES (?, ?, ?, ?, ?, '#eef2ff', ?, datetime('now'))`,
      noteId,
      tabId || null,
      sectionId || null,
      title,
      content,
      viewer.person.id
    );
    recordAudit({
      actorId: viewer.person.id,
      actorName: viewer.person.name,
      action: "note.create",
      entity: "sticky_note",
      entityId: noteId,
      after: content,
    });
  }
  revalidatePath(path);
}

export async function deleteNoteAction(formData: FormData) {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  const path = String(formData.get("path") ?? "/");
  const before = get<any>("SELECT content FROM sticky_notes WHERE id = ?", id);
  run(`DELETE FROM sticky_notes WHERE id = ?`, id);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "note.delete",
    entity: "sticky_note",
    entityId: id,
    before: before?.content,
  });
  revalidatePath(path);
}

export async function suggestNoteAction(sectionId: string): Promise<string> {
  const viewer = await getViewer();
  return suggestSectionNote(sectionId, viewer);
}

export async function togglePinnedNoteAction(formData: FormData) {
  const viewer = await getViewer();
  if (!canEdit(viewer)) return;
  const id = String(formData.get("id") ?? "");
  run(`UPDATE sticky_notes SET pinned = 1 - pinned WHERE id = ?`, id);
  revalidatePath(String(formData.get("path") ?? "/"));
}
