import { get } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getViewer } from "@/lib/access";
import { ensureBootstrapped } from "@/lib/bootstrap";
import { readEnhancementMarkdown } from "@/lib/enhancements";
import { statusAfterArchive } from "@/lib/enhancement-status";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  const session = await getSession();
  if (!session) return new Response("Authentication required", { status: 401, headers: { "Cache-Control": "no-store" } });
  const viewer = await getViewer();
  const { id } = await context.params;
  const item = get<any>(
    `SELECT e.*, p.name AS submitted_by_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
      WHERE (e.id = ? OR e.ref = ?) AND e.company_id = ?`,
    id,
    id,
    viewer.org.company.id
  );
  if (!item) return new Response("Not found", { status: 404 });

  const { filename, content } = readEnhancementMarkdown(item);
  const safeDispositionName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  // The response below carries the database status into the frontmatter, so an
  // archived record can never hand back an active "Building" document.
  const status = statusAfterArchive(item.status);

  return new Response(content, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeDispositionName}"`,
      "X-Requested-By": session.person.email ?? "",
      "X-Enhancement-Status": status,
    },
  });
}
