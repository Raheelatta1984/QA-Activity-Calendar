import { notesFor } from "@/lib/notes";
import { StickyNotes } from "./StickyNotes";
import { get } from "@/lib/db";

export function Section({
  id,
  tabId,
  title,
  description,
  action,
  children,
  path,
  canEdit = false,
  bare = false,
}: {
  id: string;
  tabId: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  path: string;
  canEdit?: boolean;
  bare?: boolean;
}) {
  const notes = notesFor(tabId, id);
  const config = get<{ enabled: number }>(`SELECT enabled FROM sections WHERE id = ?`, id);
  const disabled = config ? !config.enabled : false;
  if (disabled && !canEdit) return null;
  return (
    <section className="section" id={id} aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <div>
          <div className="section-title">
            <h2 id={`${id}-title`}>{title}</h2>
            <span className="id-chip" title="Stable section ID — quote this in enhancement requests">
              {id}
            </span>
          </div>
          {description ? <div className="section-desc">{description}</div> : null}
        </div>
        {action}
      </div>
      {disabled ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          This section is disabled for users. Administrators still see it so it can be re-enabled from Master Setup.
        </div>
      ) : null}
      <StickyNotes
        notes={notes}
        tabId={tabId}
        sectionId={id}
        path={path}
        canEdit={canEdit}
      />
      {bare ? children : <div className="card">{children}</div>}
    </section>
  );
}
