"use client";

import { useActionState, useEffect, useState } from "react";
import { Icon } from "./icons";
import {
  draftEnhancementAction,
  saveEnhancementAction,
  type DraftState,
  type EnhancementState,
} from "@/app/actions/enhancements";

const AREAS = [
  "QA Calendar",
  "Capacity",
  "Pipeline",
  "Reporting",
  "Releases",
  "Master Setup",
  "App configuration",
  "Integrations",
  "AI assistance",
  "Import Centre",
];

export function EnhancementStudio({
  departments,
  canEdit,
}: {
  departments: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [draftState, draftAction, drafting] = useActionState<DraftState, FormData>(draftEnhancementAction, {});
  const [saveState, saveAction, saving] = useActionState<EnhancementState, FormData>(saveEnhancementAction, {});

  const [raw, setRaw] = useState("");
  const [area, setArea] = useState(AREAS[0]);
  const [outcome, setOutcome] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [requirements, setRequirements] = useState("");
  const [impacts, setImpacts] = useState("");
  const [expected, setExpected] = useState("");
  const [criteria, setCriteria] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [department, setDepartment] = useState("");
  const [sections, setSections] = useState("");
  const [drafted, setDrafted] = useState(false);

  useEffect(() => {
    if (draftState.draft) {
      setTitle(draftState.draft.title);
      setBrief(draftState.draft.brief);
      setRequirements(draftState.draft.requirements);
      setImpacts(draftState.draft.impacts);
      setExpected(draftState.draft.expectedOutcome);
      setCriteria(draftState.draft.successCriteria);
      setDrafted(true);
    }
  }, [draftState.draft]);

  useEffect(() => {
    if (saveState.ok) {
      setRaw("");
      setTitle("");
      setBrief("");
      setRequirements("");
      setImpacts("");
      setExpected("");
      setCriteria("");
      setMarkdown("");
      setOutcome("");
      setDrafted(false);
    }
  }, [saveState.ok]);

  const generatedMarkdown = `## ${title || "Untitled"}

**Brief** — ${brief || "—"}

**Requirements**
${requirements || "—"}

**Impacts**
${impacts || "—"}

**Expected outcome** — ${expected || "—"}

**Success criteria**
${criteria || "—"}

_Authored in the HFM QA Calendar enhancement studio.${sections ? ` Affected IDs: ${sections}.` : ""}_`;

  return (
    <div className="card card-pad stack">
      <div className="banner info">
        <Icon name="sparkles" size={15} />
        <span>
          Describe the problem, then let the assistant structure it. The draft is deterministic and generated on this
          server — nothing is sent to a third party. You stay the author.
        </span>
      </div>

      <form action={saveAction} className="stack">
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="raw">What needs to change?</label>
            <textarea
              id="raw"
              className="textarea"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Paste a Markdown handover or describe the problem in plain language. e.g. 'Managers need a rolling three-month capacity forecast per department so we can plan contractors.'"
              style={{ minHeight: 110 }}
            />
          </div>
          <div className="field">
            <label htmlFor="area">Area</label>
            <select id="area" className="select" value={area} onChange={(e) => setArea(e.target.value)}>
              {AREAS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="outcome-hint">Outcome you want</label>
            <input
              id="outcome-hint"
              className="input"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="Optional — a sentence is enough"
            />
          </div>
          <div className="field">
            <label htmlFor="sections">Impacted tab / section IDs</label>
            <input
              id="sections"
              className="input"
              value={sections}
              onChange={(e) => setSections(e.target.value)}
              placeholder="e.g. sec.capacity.pivot, tab.releases"
            />
          </div>
          <div className="field">
            <label htmlFor="department">Department</label>
            <select id="department" className="select" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <button className="btn btn-sm" type="submit" formAction={draftAction} disabled={drafting || !canEdit}>
            <Icon name="sparkles" size={13} /> {drafting ? "Drafting…" : "Draft with AI"}
          </button>
          {drafted ? <span className="badge badge-green">Draft ready — review every field below</span> : null}
          {draftState.error ? <span className="badge badge-red">{draftState.error}</span> : null}
        </div>

        <div className="divider" />

        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="title">Title *</label>
            <input id="title" className="input" name="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="field span-2">
            <label htmlFor="brief">Brief *</label>
            <textarea id="brief" className="textarea" name="brief" value={brief} onChange={(e) => setBrief(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="requirements">Requirements</label>
            <textarea
              id="requirements"
              className="textarea"
              name="requirements"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              style={{ minHeight: 120 }}
            />
          </div>
          <div className="field">
            <label htmlFor="impacts">Impacts</label>
            <textarea
              id="impacts"
              className="textarea"
              name="impacts"
              value={impacts}
              onChange={(e) => setImpacts(e.target.value)}
              style={{ minHeight: 120 }}
            />
          </div>
          <div className="field">
            <label htmlFor="expected">Expected outcome</label>
            <textarea
              id="expected"
              className="textarea"
              name="expected_outcome"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="criteria">Success criteria</label>
            <textarea
              id="criteria"
              className="textarea"
              name="success_criteria"
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="markdown">Markdown handover (optional)</label>
            <textarea
              id="markdown"
              className="textarea"
              name="markdown"
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder="Paste an existing MD file here. Leave blank to generate it from the fields above."
              style={{ minHeight: 90 }}
            />
          </div>
        </div>

        <input type="hidden" name="status" value="Submitted" />
        <input type="hidden" name="department_id" value={department} />
        <input type="hidden" name="sections" value={sections} />
        <input type="hidden" name="ai_title" value={draftState.draft?.title ?? ""} />
        <input type="hidden" name="ai_model" value={draftState.draft?.provider ?? "local"} />

        <details className="card" style={{ padding: "10px 14px" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)" }}>
            Preview generated markdown
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.76rem", color: "var(--text-dim)", marginTop: 8 }}>
            {markdown || generatedMarkdown}
          </pre>
        </details>

        {saveState.error ? (
          <div className="banner bad">
            <Icon name="alert" size={15} /> {saveState.error}
          </div>
        ) : null}
        {saveState.ok ? (
          <div className="banner good">
            <Icon name="check" size={15} /> Saved as <strong>{saveState.ref}</strong> — markdown written to the repository
            vault.
          </div>
        ) : null}

        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className="btn btn-primary" type="submit" disabled={saving || !canEdit}>
            {saving ? "Saving…" : "Submit to enhancement pipeline"}
          </button>
        </div>
      </form>
    </div>
  );
}
