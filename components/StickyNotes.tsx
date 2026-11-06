"use client";

import { useState, useTransition } from "react";
import { Icon } from "./icons";
import { deleteNoteAction, saveNoteAction, suggestNoteAction } from "@/app/actions/notes";

export type NoteItem = {
  id: string;
  title: string;
  content: string;
  updated_at: string;
  ai_generated: number;
  author_name?: string | null;
};

export function StickyNotes({
  notes,
  tabId,
  sectionId,
  path,
  canEdit,
}: {
  notes: NoteItem[];
  tabId: string;
  sectionId?: string;
  path: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("AI guidance");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function startNew() {
    setEditing("new");
    setTitle("AI guidance");
    setDraft("");
    setError(null);
  }

  function startEdit(note: NoteItem) {
    setEditing(note.id);
    setTitle(note.title);
    setDraft(note.content);
    setError(null);
  }

  function aiDraft() {
    startTransition(async () => {
      try {
        const text = await suggestNoteAction(sectionId ?? tabId);
        setDraft(text);
        if (editing === null || editing === "new" || !draft) setEditing(editing ?? "new");
      } catch {
        setError("Could not generate a suggestion. Try again.");
      }
    });
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="sticky-list">
        {notes.map((note) =>
          editing === note.id ? (
            <form key={note.id} action={saveNoteAction} className="sticky is-editing card" style={{ padding: 12 }}>
              <input type="hidden" name="id" value={note.id} />
              <input type="hidden" name="tabId" value={tabId} />
              <input type="hidden" name="sectionId" value={sectionId ?? ""} />
              <input type="hidden" name="path" value={path} />
              <div className="field" style={{ marginBottom: 8 }}>
                <input className="input input-sm" name="title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" />
              </div>
              <textarea
                className="textarea"
                name="content"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ minHeight: 90, fontSize: "0.82rem" }}
                aria-label="Note content"
              />
              <div className="sticky-tools" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button className="btn btn-sm" type="button" onClick={aiDraft} disabled={pending}>
                  <Icon name="sparkles" size={13} /> {pending ? "Thinking…" : "AI draft"}
                </button>
                <button className="btn btn-sm btn-primary" type="submit" disabled={!draft.trim()}>
                  Save note
                </button>
              </div>
            </form>
          ) : (
            <div className="sticky" key={note.id}>
              <strong>{note.title}</strong> · {note.content.replace(/^AI guidance\s*·\s*/i, "")}
              {canEdit ? (
                <div className="sticky-tools">
                  <button className="btn btn-sm btn-ghost" onClick={() => startEdit(note)} type="button">
                    <Icon name="edit" size={12} /> Edit
                  </button>
                  <form action={deleteNoteAction}>
                    <input type="hidden" name="id" value={note.id} />
                    <input type="hidden" name="path" value={path} />
                    <button className="btn btn-sm btn-ghost" type="submit">
                      <Icon name="trash" size={12} /> Remove
                    </button>
                  </form>
                  <span className="muted" style={{ fontSize: "0.68rem", marginLeft: "auto" }}>
                    {note.author_name ? `${note.author_name} · ` : ""}
                    {note.updated_at.slice(0, 10)}
                  </span>
                </div>
              ) : null}
            </div>
          )
        )}

        {!notes.length && editing === null ? (
          <div className="sticky">
            <strong>AI guidance</strong> · No note on this section yet. Add one so the team reads the same rule.
          </div>
        ) : null}
      </div>

      {editing === "new" ? (
        <form action={saveNoteAction} className="card card-pad" style={{ marginBottom: 10 }}>
          <input type="hidden" name="tabId" value={tabId} />
          <input type="hidden" name="sectionId" value={sectionId ?? ""} />
          <input type="hidden" name="path" value={path} />
          <div className="form-grid">
            <div className="field">
              <label>Title</label>
              <input className="input input-sm" name="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field span-2">
              <label>Content</label>
              <textarea
                className="textarea"
                name="content"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What should everyone know before using this section?"
              />
            </div>
          </div>
          {error ? <div className="banner bad" style={{ marginTop: 8 }}>{error}</div> : null}
          <div className="form-actions">
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn btn-sm" type="button" onClick={aiDraft} disabled={pending}>
              <Icon name="sparkles" size={13} /> {pending ? "Thinking…" : "AI draft"}
            </button>
            <button className="btn btn-sm btn-primary" type="submit" disabled={!draft.trim()}>
              Add note
            </button>
          </div>
        </form>
      ) : null}

      {canEdit && editing === null ? (
        <button className="btn btn-sm btn-ghost" type="button" onClick={startNew}>
          <Icon name="plus" size={13} /> Add guidance note
        </button>
      ) : null}
    </div>
  );
}
