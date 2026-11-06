import { get } from "@/lib/db";
import { getViewer } from "@/lib/access";
import { readEnhancementMarkdown } from "@/lib/enhancements";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  const { id } = await context.params;
  const item = get<any>(
    `SELECT e.*, p.name AS submitted_by_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
      WHERE e.id = ? OR e.ref = ?`,
    id,
    id
  );
  if (!item) return new Response("Not found", { status: 404 });

  const { filename, content } = readEnhancementMarkdown(item);
  const safeDispositionName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeDispositionName}"`,
      "X-Requested-By": viewer.person.email,
    },
  });
}
