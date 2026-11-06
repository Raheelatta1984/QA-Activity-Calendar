"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientActivity, ClientDepartment, ClientPerson, ClientPipeline, DayMeta } from "./types";
import { ActivityForm } from "./ActivityForm";
import { Icon } from "./icons";
import { recordActualAction } from "@/app/actions/activities";

type MonthOption = { key: string; label: string; quarter: number };
type QuarterOption = { quarter: number; label: string; months: MonthOption[] };
type YearOption = { label: string; startYear: number };

const STATUS_BADGE: Record<string, string> = {
  Planned: "badge-slate",
  "In Progress": "badge-blue",
  Complete: "badge-green",
  Blocked: "badge-red",
  Deferred: "badge-amber",
  Cancelled: "badge-slate",
};

export function CalendarBoard({
  monthKey,
  monthLabel,
  selectedYear,
  selectedQuarter,
  years,
  quarters,
  days,
  todayIso,
  activities,
  pipeline,
  people,
  departments,
  legend,
  holidays,
  canEdit,
  path,
}: {
  monthKey: string;
  monthLabel: string;
  selectedYear: string;
  selectedQuarter: number | null;
  years: YearOption[];
  quarters: QuarterOption[];
  days: DayMeta[][];
  todayIso: string;
  activities: ClientActivity[];
  pipeline: ClientPipeline[];
  people: ClientPerson[];
  departments: ClientDepartment[];
  legend: { name: string; hex: string }[];
  holidays: { date: string; name: string }[];
  canEdit: boolean;
  path: string;
}) {
  const router = useRouter();
  const [group, setGroup] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"both" | "qa" | "pipeline">("both");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [openPipelineId, setOpenPipelineId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClientActivity | null>(null);
  const [newDate, setNewDate] = useState<string>(todayIso);

  const groups = useMemo(() => [...new Set(activities.map((a) => a.group))].sort(), [activities]);

  const filteredActivities = useMemo(
    () =>
      activities.filter((a) => {
        if (group !== "all" && a.group !== group) return false;
        if (assignee !== "all" && (a.assignee_id ?? "unassigned") !== assignee) return false;
        if (status !== "all" && a.status !== status) return false;
        if (query) {
          const q = query.toLowerCase();
          if (!`${a.activity} ${a.detail ?? ""} ${a.code ?? ""} ${a.assignee_name}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [activities, group, assignee, status, query]
  );

  const filteredPipeline = useMemo(
    () =>
      pipeline.filter((p) => {
        if (assignee !== "all" && p.assignee_name !== people.find((x) => x.id === assignee)?.name) return false;
        if (query) {
          const q = query.toLowerCase();
          if (!`${p.activity} ${p.detail ?? ""}`.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [pipeline, assignee, query, people]
  );

  function navigate(next: Record<string, string | number | null>) {
    const params = new URLSearchParams();
    const merged: Record<string, string | number | null> = {
      fy: selectedYear,
      q: selectedQuarter ?? "",
      month: monthKey,
      ...next,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== null && value !== "") params.set(key, String(value));
    }
    router.push(`${path}?${params.toString()}`);
  }

  function stepMonth(delta: number) {
    const index = quarters.flatMap((q) => q.months).findIndex((m) => m.key === monthKey);
    const months = quarters.flatMap((q) => q.months);
    const next = months[index + delta];
    if (next) navigate({ month: next.key, q: next.quarter });
  }

  const open = filteredActivities.find((a) => a.id === openId) ?? activities.find((a) => a.id === openId) ?? null;
  const openPipeline = pipeline.find((p) => p.id === openPipelineId) ?? null;
  const monthMeta = quarters.flatMap((q) => q.months).find((m) => m.key === monthKey);

  const showQa = view !== "pipeline";
  const showPipeline = view !== "qa";

  return (
    <div className="stack">
      <div className="row-between">
        <div className="row" style={{ gap: 8 }}>
          <button className="icon-btn" onClick={() => stepMonth(-1)} aria-label="Previous month">
            <Icon name="chevronLeft" size={16} />
          </button>
          <div style={{ minWidth: 150 }}>
            <div style={{ fontWeight: 700, fontSize: "0.96rem" }}>{monthLabel}</div>
            <div className="card-sub">
              {selectedYear}
              {selectedQuarter ? ` · Q${selectedQuarter}` : ""}
            </div>
          </div>
          <button className="icon-btn" onClick={() => stepMonth(1)} aria-label="Next month">
            <Icon name="chevronRight" size={16} />
          </button>
          <button className="btn btn-sm" onClick={() => navigate({ month: todayIso.slice(0, 7) })}>
            Today
          </button>
        </div>

        <div className="seg" role="group" aria-label="Calendar view">
          {(["both", "qa", "pipeline"] as const).map((mode) => (
            <button key={mode} className={view === mode ? "active" : ""} onClick={() => setView(mode)}>
              {mode === "both" ? "QA + Pipeline" : mode === "qa" ? "QA only" : "Pipeline only"}
            </button>
          ))}
        </div>
      </div>

      <div className="cal-toolbar">
        <div className="field">
          <label htmlFor="fy">Fiscal year</label>
          <select
            id="fy"
            className="select select-sm"
            value={selectedYear}
            onChange={(e) => {
              const option = years.find((y) => y.label === e.target.value);
              navigate({ fy: e.target.value, q: "", month: option ? `${option.startYear}-07` : monthKey });
            }}
          >
            {years.map((y) => (
              <option key={y.label} value={y.label}>
                {y.label} · Jul {y.startYear} – Jun {y.startYear + 1}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="quarter">Quarter</label>
          <select
            id="quarter"
            className="select select-sm"
            value={selectedQuarter ?? ""}
            onChange={(e) => {
              const q = Number(e.target.value);
              const target = quarters.find((x) => x.quarter === q)?.months[0];
              navigate({ q: e.target.value, month: target?.key ?? monthKey });
            }}
          >
            <option value="">All quarters</option>
            {quarters.map((q) => (
              <option key={q.quarter} value={q.quarter}>
                {q.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="month">Month</label>
          <select
            id="month"
            className="select select-sm"
            value={monthKey}
            onChange={(e) => {
              const m = quarters.flatMap((q) => q.months).find((x) => x.key === e.target.value);
              navigate({ month: e.target.value, q: m?.quarter ?? "" });
            }}
          >
            {quarters.flatMap((q) => q.months).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="group">Activity group</label>
          <select id="group" className="select select-sm" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="all">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="assignee">Assignee</label>
          <select id="assignee" className="select select-sm" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="all">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            {["Planned", "In Progress", "Complete", "Blocked", "Deferred", "Cancelled"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="field grow" style={{ maxWidth: 240 }}>
          <label htmlFor="search">Search</label>
          <input
            id="search"
            className="input input-sm"
            placeholder="Activity, ID, owner…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {canEdit ? (
          <button
            className="btn btn-primary btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setEditing(null);
              setNewDate(todayIso);
              setFormOpen(true);
            }}
          >
            <Icon name="plus" size={14} /> New activity
          </button>
        ) : null}
      </div>

      <div className="cal-grid" role="grid" aria-label={`${monthLabel} activity calendar`}>
        <div className="cal-dow" role="row">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} role="columnheader">
              {d}
            </div>
          ))}
        </div>

        {days.map((week, weekIndex) => (
          <div className="cal-week" key={weekIndex} role="row">
            {week.map((day) => {
              const dayActivities = showQa
                ? filteredActivities.filter(
                    (a) => a.start_date && a.end_date && a.start_date <= day.date && a.end_date >= day.date
                  )
                : [];
              const dayPipeline = showPipeline
                ? filteredPipeline.filter(
                    (p) => p.effective_start && p.effective_end && p.effective_start <= day.date && p.effective_end >= day.date
                  )
                : [];
              const total = dayActivities.length + dayPipeline.length;
              const shown = dayActivities.slice(0, 3);
              const pipelineShown = dayPipeline.slice(0, Math.max(0, 3 - shown.length));

              return (
                <div
                  key={day.date}
                  role="gridcell"
                  className={[
                    "cal-day",
                    day.inMonth ? "" : "out",
                    day.isWeekend ? "weekend" : "",
                    day.isHoliday ? "holiday" : "",
                    day.isToday ? "today" : "",
                    day.isCurrentWeek ? "current-week" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onDoubleClick={() => {
                    if (!canEdit) return;
                    setEditing(null);
                    setNewDate(day.date);
                    setFormOpen(true);
                  }}
                >
                  <div className="cal-day-head">
                    <span className="cal-day-num">{day.day}</span>
                    {day.isHoliday ? <span className="cal-holiday-tag">{day.holidayName}</span> : null}
                  </div>
                  <div className="cal-items">
                    {shown.map((a) => {
                      const continuesLeft = a.start_date !== day.date;
                      const continuesRight = a.end_date !== day.date;
                      return (
                        <button
                          key={`${a.id}-${day.date}`}
                          className={`cal-chip ${continuesLeft ? "cont-left" : ""} ${continuesRight ? "cont-right" : ""}`}
                          style={{
                            background: `linear-gradient(90deg, ${a.colour}, ${a.colour}cc)`,
                            opacity: continuesLeft ? 0.62 : 1,
                          }}
                          onClick={() => setOpenId(a.id)}
                          title={`${a.activity} · ${a.assignee_name} · ${a.status}`}
                        >
                          {continuesLeft ? "◂ " : ""}
                          {continuesRight ? "" : ""}
                          {a.activity}
                        </button>
                      );
                    })}
                    {pipelineShown.map((p) => (
                      <button
                        key={`${p.id}-${day.date}`}
                        className="cal-chip pipeline"
                        onClick={() => setOpenPipelineId(p.id)}
                        title={`${p.activity} · ${p.current_status}`}
                      >
                        REC · {p.activity}
                      </button>
                    ))}
                    {total > shown.length + pipelineShown.length ? (
                      <span className="cal-more">+{total - shown.length - pipelineShown.length} more</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="cal-legend">
          <span>
            <span className="legend-swatch" style={{ background: "var(--brand)" }} /> Active activity
          </span>
          <span>
            <span className="legend-swatch" style={{ background: "var(--warn)", opacity: 0.6 }} /> NSW public holiday
          </span>
          <span>
            <span className="legend-swatch" style={{ background: "var(--surface-3)", border: "1px dashed var(--border-strong)" }} />{" "}
            Recording pipeline
          </span>
          <span>Current week tinted · today outlined</span>
        </div>
        <div className="cal-legend">
          {legend.slice(0, 6).map((l) => (
            <span key={l.name}>
              <span className="legend-swatch" style={{ background: l.hex }} /> {l.name}
            </span>
          ))}
        </div>
      </div>

      {holidays.length ? (
        <details className="card" style={{ padding: "10px 14px" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>
            {holidays.length} NSW public holiday{holidays.length === 1 ? "" : "s"} in {monthLabel}
          </summary>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            {holidays.map((h) => (
              <span className="badge badge-amber" key={h.date}>
                {h.date.slice(8)} {monthLabel.split(" ")[0]} · {h.name}
              </span>
            ))}
          </div>
        </details>
      ) : null}

      {/* ------------------------------------------------------------ drawer */}
      {open ? (
        <>
          <div className="drawer-backdrop" onClick={() => setOpenId(null)} />
          <aside className="drawer" role="dialog" aria-label={open.activity}>
            <div className="drawer-head">
              <div
                style={{ width: 6, alignSelf: "stretch", borderRadius: 4, background: open.colour, flex: "0 0 6px" }}
              />
              <div className="grow">
                <h2 style={{ fontSize: "1.05rem" }}>{open.activity}</h2>
                <div className="card-sub">
                  <span className="mono">{open.code}</span> · {open.group} · {open.department_name}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setOpenId(null)} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="drawer-body stack">
              <div className="row">
                <span className={`badge ${STATUS_BADGE[open.status] ?? "badge-slate"}`}>{open.status}</span>
                <span className="badge badge-slate">{open.priority} priority</span>
                {open.active ? <span className="badge badge-green">Active</span> : <span className="badge badge-slate">Inactive</span>}
                {open.scheduled ? null : <span className="badge badge-red">Unscheduled</span>}
                <span className="badge badge-purple">{open.fte} FTE</span>
              </div>

              {open.detail ? <p className="dim" style={{ fontSize: "0.86rem" }}>{open.detail}</p> : null}

              <div>
                <div className="row-between" style={{ marginBottom: 5 }}>
                  <span className="label">Completion</span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{open.progress}%</span>
                </div>
                <div className={`progress progress-lg ${open.progress >= 100 ? "good" : open.progress < 30 ? "warn" : ""}`}>
                  <span style={{ width: `${Math.max(2, open.progress)}%` }} />
                </div>
                <div className="card-sub" style={{ marginTop: 5 }}>
                  Derived from {open.bug_reported} linked bug{open.bug_reported === 1 ? "" : "s"} —{" "}
                  {open.bug_closed} closed, {open.bug_fixed} fixed, {open.bug_outstanding} outstanding.
                </div>
              </div>

              <div className="card card-pad">
                <div className="label" style={{ marginBottom: 6 }}>Schedule</div>
                <div className="stat-line">
                  <span className="muted">Planned</span>
                  <span>
                    {open.planned_start ?? "—"} → {open.planned_end ?? "—"}
                  </span>
                </div>
                <div className="stat-line">
                  <span className="muted">Actual</span>
                  <span>
                    {open.actual_start ?? "not started"} → {open.actual_end ?? "open"}
                  </span>
                </div>
                <div className="stat-line">
                  <span className="muted">Duration</span>
                  <span>{open.duration_days ?? "—"} calendar days (inclusive)</span>
                </div>
                <div className="stat-line">
                  <span className="muted">Assignee</span>
                  <span>{open.assignee_name}</span>
                </div>
                <div className="stat-line">
                  <span className="muted">Provenance</span>
                  <span>
                    {open.source_sheet ?? "app"}
                    {open.source_row ? ` · row ${open.source_row}` : ""}
                  </span>
                </div>
              </div>

              {open.notes ? (
                <div>
                  <div className="label" style={{ marginBottom: 4 }}>Notes</div>
                  <p className="dim" style={{ fontSize: "0.84rem" }}>{open.notes}</p>
                </div>
              ) : null}

              {open.data_quality ? (
                <div className="banner warn">
                  <Icon name="alert" size={15} /> {open.data_quality}
                </div>
              ) : null}

              {canEdit ? (
                <div className="row">
                  <form action={recordActualAction}>
                    <input type="hidden" name="id" value={open.id} />
                    <input type="hidden" name="which" value="start" />
                    <input type="hidden" name="date" value={todayIso} />
                    <input type="hidden" name="path" value={path} />
                    <button className="btn btn-sm" type="submit" disabled={!!open.actual_start}>
                      <Icon name="clock" size={13} /> Record actual start
                    </button>
                  </form>
                  <form action={recordActualAction}>
                    <input type="hidden" name="id" value={open.id} />
                    <input type="hidden" name="which" value="end" />
                    <input type="hidden" name="date" value={todayIso} />
                    <input type="hidden" name="path" value={path} />
                    <button className="btn btn-sm" type="submit" disabled={!open.actual_start || !!open.actual_end}>
                      <Icon name="check" size={13} /> Mark complete
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
            <div className="drawer-foot">
              <button className="btn" onClick={() => setOpenId(null)}>
                Close
              </button>
              {canEdit ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setEditing(open);
                    setFormOpen(true);
                    setOpenId(null);
                  }}
                >
                  <Icon name="edit" size={14} /> Edit activity
                </button>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}

      {openPipeline ? (
        <>
          <div className="drawer-backdrop" onClick={() => setOpenPipelineId(null)} />
          <aside className="drawer" role="dialog" aria-label={openPipeline.activity}>
            <div className="drawer-head">
              <div className="grow">
                <h2 style={{ fontSize: "1.05rem" }}>{openPipeline.activity}</h2>
                <div className="card-sub">
                  <span className="mono">{openPipeline.code}</span> · Recording pipeline
                </div>
              </div>
              <button className="icon-btn" onClick={() => setOpenPipelineId(null)} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="drawer-body stack">
              <div className="row">
                <span className="badge badge-purple">{openPipeline.current_status}</span>
                <span className="badge badge-slate">{openPipeline.recording_status}</span>
                {openPipeline.is_test ? <span className="badge badge-amber">TEST</span> : null}
              </div>
              {openPipeline.detail ? <p className="dim">{openPipeline.detail}</p> : null}
              <div className="card card-pad">
                <div className="stat-line">
                  <span className="muted">Effective window</span>
                  <span>
                    {openPipeline.effective_start ?? "—"} → {openPipeline.effective_end ?? "—"}
                  </span>
                </div>
                <div className="stat-line">
                  <span className="muted">Eligible days</span>
                  <span>{openPipeline.eligible_days}</span>
                </div>
                <div className="stat-line">
                  <span className="muted">Blocked days</span>
                  <span>{openPipeline.blocked_days.length}</span>
                </div>
                <div className="stat-line">
                  <span className="muted">Automation</span>
                  <span>{openPipeline.automation_percent}%</span>
                </div>
              </div>
              {openPipeline.blocker ? (
                <div className="banner warn">
                  <Icon name="alert" size={15} /> Blocker: {openPipeline.blocker}
                </div>
              ) : null}
              {openPipeline.warnings.map((w) => (
                <div className="banner bad" key={w}>
                  <Icon name="info" size={15} /> {w}
                </div>
              ))}
            </div>
            <div className="drawer-foot">
              <button className="btn" onClick={() => setOpenPipelineId(null)}>
                Close
              </button>
              <a className="btn btn-primary" href="/pipeline">
                Open in pipeline
              </a>
            </div>
          </aside>
        </>
      ) : null}

      {formOpen ? (
        <ActivityForm
          activity={editing}
          people={people}
          departments={departments}
          defaultDate={newDate}
          path={path}
          canEdit={canEdit}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      ) : null}

      <div className="card-sub">
        Showing {filteredActivities.length} active activities
        {showPipeline ? ` and ${filteredPipeline.length} pipeline items` : ""} for {monthLabel}
        {monthMeta ? ` · Q${monthMeta.quarter} ${selectedYear}` : ""}. Double-click an empty day to create an activity.
      </div>
    </div>
  );
}
