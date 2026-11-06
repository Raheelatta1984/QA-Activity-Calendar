import { get } from "@/lib/db";
import { getViewer } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  const { id } = await context.params;
  const item = get<any>(`SELECT * FROM enhancements WHERE id = ? OR ref = ?`, id, id);
  if (!item) return new Response("Not found", { status: 404 });

  const body =
    item.markdown ??
    `# ${item.title}\n\n${item.brief ?? ""}\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${item.ref}.md"`,
      "X-Requested-By": viewer.person.email,
    },
  });
}
