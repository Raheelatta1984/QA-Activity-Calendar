"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import {
  draftEnhancementAction,
  saveEnhancementAction,
  suggestEnhancementFieldsAction,
  type DraftState,
  type EnhancementState,
  type SuggestionState,
} from "@/app/actions/enhancements";
import {
  FIELD_LABELS,
  SHORT_SUGGESTION_FIELDS,
  SUGGESTION_FIELDS,
  type SuggestionField,
} from "@/lib/enhancement-fields";

const AREAS = [
  "QA Calendar",
  "FTE Calendar",
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

type FieldKey = SuggestionField;
type Values = Record<FieldKey, string>;

const EMPTY: Values = {
  outcome: "",
  sections: "",
  title: "",
  brief: "",
  requirements: "",
  impacts: "",
  expectedOutcome: "",
  successCriteria: "",
  markdown: "",
};

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
  const [values, setValues] = useState<Values>(EMPTY);
  const [department, setDepartment] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestionState["suggestions"]>(undefined);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [autoApply, setAutoApply] = useState(true);
  /** Fields the author has typed into — the assistant never overwrites these. */
  const [edited, setEdited] = useState<FieldKey[]>([]);
  /** Fields whose current value came from the assistant. */
  const [aiSourced, setAiSourced] = useState<FieldKey[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);

  // Refs keep the debounced effect stable: applying a suggestion must not
  // re-trigger the fetch (which would loop).
  const valuesRef = useRef(values);
  const editedRef = useRef<FieldKey[]>([]);
  const aiRef = useRef<FieldKey[]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    valuesRef.current = values;
  }, [values]);
  useEffect(() => {
    editedRef.current = edited;
  }, [edited]);
  useEffect(() => {
    aiRef.current = aiSourced;
  }, [aiSourced]);

  const setValue = useCallback((key: FieldKey, value: string, fromAi = false) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (fromAi) {
      setAiSourced((current) => (current.includes(key) ? current : [...current, key]));
      return;
    }
    setAiSourced((current) => current.filter((item) => item !== key));
    setEdited((current) => (current.includes(key) ? current : [...current, key]));
  }, []);

  /** Fetch — and optionally apply — live suggestions for the current text. */
  const runSuggestions = useCallback(
    async (applyToUntouched: boolean) => {
      const token = ++requestId.current;
      if (raw.trim().length < 12) {
        setSuggestError(null);
        setSuggesting(false);
        return;
      }
      setSuggesting(true);
      setSuggestError(null);
      const current = valuesRef.current;
      try {
        const result = await suggestEnhancementFieldsAction({
          raw,
          area,
          outcome: current.outcome,
          title: current.title,
          brief: current.brief,
          requirements: current.requirements,
          impacts: current.impacts,
          expectedOutcome: current.expectedOutcome,
          successCriteria: current.successCriteria,
          sections: current.sections,
        });
        if (token !== requestId.current) return; // a newer keystroke won
        if (result.error) {
          setSuggestError(result.error);
          setSuggestions(undefined);
          return;
        }
        setSuggestions(result.suggestions);
        setLastRun(new Date().toLocaleTimeString("en-AU"));
        if (!applyToUntouched || !result.suggestions) return;
        for (const field of SUGGESTION_FIELDS) {
          if (editedRef.current.includes(field)) continue; // author owns this field
          const next = result.suggestions[field]?.[0];
          if (!next) continue;
          // A handover the author wrote by hand is never replaced; a blank one
          // (or one already drafted by the assistant) is kept up to date.
          if (field === "markdown" && valuesRef.current.markdown.trim() && !aiRef.current.includes("markdown")) continue;
          setValue(field, next, true);
        }
      } catch (error) {
        if (token === requestId.current) {
          setSuggestError(error instanceof Error ? error.message : "Suggestions are unavailable right now.");
        }
      } finally {
        if (token === requestId.current) setSuggesting(false);
      }
    },
    [raw, area, setValue]
  );

  // Debounced, real-time drafting: runs while the author types the request.
  useEffect(() => {
    if (!autoApply) return;
    if (raw.trim().length < 12) return;
    const timer = setTimeout(() => void runSuggestions(true), 700);
    return () => clearTimeout(timer);
  }, [raw, area, autoApply, runSuggestions]);

  // "Fill all fields" overwrites everything, including manual edits — it is the
  // explicit bulk action, unlike the live suggestions above.
  useEffect(() => {
    if (!draftState.draft) return;
    setValues((current) => ({
      ...current,
      title: draftState.draft!.title,
      brief: draftState.draft!.brief,
      requirements: draftState.draft!.requirements,
      impacts: draftState.draft!.impacts,
      expectedOutcome: draftState.draft!.expectedOutcome,
      successCriteria: draftState.draft!.successCriteria,
    }));
    setAiSourced(["title", "brief", "requirements", "impacts", "expectedOutcome", "successCriteria"]);
  }, [draftState.draft]);

  useEffect(() => {
    if (!saveState.ok) return;
    setRaw("");
    setValues(EMPTY);
    setEdited([]);
    setAiSourced([]);
    setSuggestions(undefined);
    setSuggestError(null);
    setLastRun(null);
  }, [saveState.ok]);

  const generatedMarkdown = `## ${values.title || "Untitled"}\n\n**Brief** — ${values.brief || "—"}\n\n**Requirements**\n${values.requirements || "—"}\n\n**Impacts**\n${values.impacts || "—"}\n\n**Expected outcome** — ${values.expectedOutcome || "—"}\n\n**Success criteria**\n${values.successCriteria || "—"}\n\n_Authored in the HFM QA Calendar enhancement studio.${values.sections ? ` Affected IDs: ${values.sections}.` : ""}_`;

  function resetAll() {
    setSuggestions(undefined);
    setAiSourced([]);
    setValues((current) => {
      const next = { ...current };
      for (const field of SUGGESTION_FIELDS) if (!edited.includes(field)) next[field] = "";
      return next;
    });
  }

  function renderSuggestionBar(field: FieldKey) {
    const options = (suggestions?.[field] ?? []).filter(Boolean);
    const isAi = aiSourced.includes(field);
    const isEdited = edited.includes(field);
    const showText = SHORT_SUGGESTION_FIELDS.includes(field);
    if (!options.length && !suggesting && !isAi && !isEdited) return null;
    return (
      <div className="ai-bar">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {options.length ? (
            <span className="badge badge-purple" title="Generated locally on this server — no data leaves it">
              <Icon name="sparkles" size={11} /> {options.length} AI option{options.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {suggesting && !options.length ? <span className="badge badge-slate">thinking…</span> : null}
          {options.map((option, index) => (
            <button
              key={`${field}-${index}`}
              type="button"
              className={`btn btn-sm ${isAi && values[field] === option ? "btn-primary" : ""}`}
              onClick={() => setValue(field, option, true)}
              title={showText ? option : option.slice(0, 300)}
            >
              {showText ? (option.length > 58 ? `${option.slice(0, 57)}…` : option) : `Option ${index + 1}`}
            </button>
          ))}
          {options.length ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void runSuggestions(true)}
              title="Generate another set of options for every field you have not edited"
            >
              <Icon name="refresh" size={12} /> Re-roll all
            </button>
          ) : null}
          {isAi && !isEdited ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setValue(field, "", false)}>
              Clear
            </button>
          ) : null}
          {isEdited ? (
            <span className="badge badge-slate" title="Suggestions stay available but never overwrite your text">
              Edited by you
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="card card-pad stack">
      <div className="banner info">
        <Icon name="sparkles" size={15} />
        <span>
          Describe the problem in “What needs to change?” and the assistant drafts the fields below in real time — each
          with two or three options to choose from. Everything stays editable: the moment you type in a field it is
          yours and suggestions stop overwriting it. Nothing is submitted until you press Submit.
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
            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              <label className="check" style={{ fontSize: "0.76rem" }}>
                <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
                Draft fields automatically as I type
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void runSuggestions(true)}
                disabled={suggesting || raw.trim().length < 12 || !canEdit}
              >
                <Icon name="sparkles" size={12} /> {suggesting ? "Drafting…" : "Draft now"}
              </button>
              {aiSourced.length ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={resetAll}>
                  Clear unedited AI text
                </button>
              ) : null}
              {lastRun ? (
                <span className="card-sub">
                  Suggestions refreshed {lastRun} · {suggestions?.provider ?? "local"} engine · nothing leaves this
                  server
                </span>
              ) : null}
            </div>
            {suggestError ? <div className="card-sub">{suggestError}</div> : null}
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
            <label htmlFor="outcome-hint">{FIELD_LABELS.outcome}</label>
            <input
              id="outcome-hint"
              className="input"
              value={values.outcome}
              onChange={(e) => setValue("outcome", e.target.value)}
              placeholder="Optional — a sentence is enough"
            />
            {renderSuggestionBar("outcome")}
          </div>
          <div className="field">
            <label htmlFor="sections">{FIELD_LABELS.sections}</label>
            <input
              id="sections"
              className="input"
              value={values.sections}
              onChange={(e) => setValue("sections", e.target.value)}
              placeholder="e.g. sec.capacity.pivot, tab.releases"
            />
            {renderSuggestionBar("sections")}
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
            <Icon name="sparkles" size={13} /> {drafting ? "Filling…" : "Fill all fields from AI"}
          </button>
          <span className="card-sub">
            “Fill all” overwrites every field, including your edits. Live suggestions never touch a field you have typed
            in.
          </span>
          {draftState.error ? <span className="badge badge-red">{draftState.error}</span> : null}
        </div>

        <div className="divider" />

        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="title">Title *</label>
            <input
              id="title"
              className="input"
              name="title"
              value={values.title}
              onChange={(e) => setValue("title", e.target.value)}
              required
            />
            {renderSuggestionBar("title")}
          </div>
          <div className="field span-2">
            <label htmlFor="brief">Brief *</label>
            <textarea
              id="brief"
              className="textarea"
              name="brief"
              value={values.brief}
              onChange={(e) => setValue("brief", e.target.value)}
              required
            />
            {renderSuggestionBar("brief")}
          </div>
          <div className="field">
            <label htmlFor="requirements">Requirements</label>
            <textarea
              id="requirements"
              className="textarea"
              name="requirements"
              value={values.requirements}
              onChange={(e) => setValue("requirements", e.target.value)}
              style={{ minHeight: 120 }}
            />
            {renderSuggestionBar("requirements")}
          </div>
          <div className="field">
            <label htmlFor="impacts">Impacts</label>
            <textarea
              id="impacts"
              className="textarea"
              name="impacts"
              value={values.impacts}
              onChange={(e) => setValue("impacts", e.target.value)}
              style={{ minHeight: 120 }}
            />
            {renderSuggestionBar("impacts")}
          </div>
          <div className="field">
            <label htmlFor="expected">Expected outcome</label>
            <textarea
              id="expected"
              className="textarea"
              name="expected_outcome"
              value={values.expectedOutcome}
              onChange={(e) => setValue("expectedOutcome", e.target.value)}
            />
            {renderSuggestionBar("expectedOutcome")}
          </div>
          <div className="field">
            <label htmlFor="criteria">Success criteria</label>
            <textarea
              id="criteria"
              className="textarea"
              name="success_criteria"
              value={values.successCriteria}
              onChange={(e) => setValue("successCriteria", e.target.value)}
            />
            {renderSuggestionBar("successCriteria")}
          </div>
          <div className="field span-2">
            <label htmlFor="markdown">Markdown handover (optional)</label>
            <textarea
              id="markdown"
              className="textarea"
              name="markdown"
              value={values.markdown}
              onChange={(e) => setValue("markdown", e.target.value)}
              placeholder="Leave blank and the assistant drafts the handover from everything above."
              style={{ minHeight: 120 }}
            />
            {renderSuggestionBar("markdown")}
          </div>
        </div>

        <input type="hidden" name="status" value="Submitted" />
        <input type="hidden" name="department_id" value={department} />
        <input type="hidden" name="sections" value={values.sections} />
        <input type="hidden" name="ai_title" value={values.title} />
        <input type="hidden" name="ai_model" value={suggestions?.provider ?? "local"} />
        <input type="hidden" name="ai_fields" value={aiSourced.join(",")} />

        <details className="card" style={{ padding: "10px 14px" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)" }}>
            Preview generated markdown
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.76rem", color: "var(--text-dim)", marginTop: 8 }}>
            {values.markdown || generatedMarkdown}
          </pre>
        </details>

        {aiSourced.length ? (
          <div className="card-sub">
            Drafted by the assistant and accepted by you: <strong>{aiSourced.join(", ")}</strong>. Recorded with the
            proposal as provenance — you remain the author.
          </div>
        ) : null}

        {saveState.error ? (
          <div className="banner bad">
            <Icon name="alert" size={15} /> {saveState.error}
          </div>
        ) : null}
        {saveState.ok ? (
          <div className="banner good">
            <Icon name="check" size={15} />
            <span>
              Saved as <strong>{saveState.ref}</strong> —{" "}
              {saveState.ephemeral ? (
                <>
                  recorded in the enhancement pipeline and written to this instance&apos;s writable vault.{" "}
                  <a href={`/api/enhancements/${saveState.ref}`} style={{ textDecoration: "underline", fontWeight: 600 }}>
                    Download Markdown
                  </a>{" "}
                  to commit it to <code className="mono">enhancements/</code>.
                </>
              ) : (
                <>markdown written to the repository vault.</>
              )}
            </span>
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
