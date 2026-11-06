import { notesFor } from "@/lib/notes";
import { StickyNotes } from "./StickyNotes";

export function PageHeader({
  id,
  title,
  description,
  meta,
  action,
  path = "/",
  canEdit = false,
}: {
  id: string;
  title: string;
  description: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  path?: string;
  canEdit?: boolean;
}) {
  const tabNotes = id.startsWith("tab.") ? notesFor(id) : [];
  return (
    <div className="page-head" style={{ marginBottom: tabNotes.length ? 10 : 18 }}>
      <div>
        <div className="row" style={{ gap: 9 }}>
          <h1>{title}</h1>
          <span className="id-chip" title="Stable tab ID — quote this in enhancement requests">
            {id}
          </span>
        </div>
        <p>{description}</p>
        {meta ? <div className="card-sub" style={{ marginTop: 6 }}>{meta}</div> : null}
      </div>
      {action ? <div className="row">{action}</div> : null}
    </div>
  );
}

export function PageGuidance({ id, path, canEdit }: { id: string; path: string; canEdit: boolean }) {
  const notes = notesFor(id);
  if (!notes.length) return null;
  return (
    <div style={{ maxWidth: 980, marginBottom: 18 }}>
      <StickyNotes notes={notes} tabId={id} path={path} canEdit={canEdit} />
    </div>
  );
}
