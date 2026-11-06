import { all } from "./db";

export function notesFor(tabId: string, sectionId?: string) {
  return all<{
    id: string;
    title: string;
    content: string;
    updated_at: string;
    ai_generated: number;
    author_name: string | null;
  }>(
    `SELECT n.*, p.name AS author_name FROM sticky_notes n LEFT JOIN people p ON p.id = n.author_id
      WHERE n.tab_id = ? AND n.enabled = 1 ${sectionId ? "AND n.section_id = ?" : "AND n.section_id IS NULL"}
      ORDER BY n.pinned DESC, n.updated_at DESC`,
    ...(sectionId ? [tabId, sectionId] : [tabId])
  );
}
