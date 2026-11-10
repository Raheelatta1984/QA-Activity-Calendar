"use client";

import { useMemo, useState } from "react";
import { Icon } from "./icons";

export type FteBoardDay = {
  date: string;
  day: number;
  weekdayShort: string;
  working: boolean;
  holiday: string | null;
  isToday: boolean;
  isWeekend: boolean;
};

export type FteBoardRow = {
  id: string;
  /** `release` rows carry release QA-window demand, not an activity record. */
  kind?: "activity" | "release";
  /** Where the row title links to. */
  href?: string;
  code: string | null;
  activity: string;
  detail: string | null;
  group: string;
  colour: string;
  status: string;
  priority: string;
  department_name: string;
  assignee_name: string;
  start_date: string | null;
  end_date: string | null;
  effective_fte: number;
  derived_progress: number;
  cells: { fte: number; active: boolean }[];
  total_fte_days: number;
  total_fte_working: number;
  covered_days: number;
};

export type FteBoardProps = {
  days: FteBoardDay[];
  rows: FteBoardRow[];
  dailyTotals: number[];
  dailyActivityCounts: number[];
  hoursPerDay: number;
  headcount: number;
  departmentName: string;
  label: string;
  canEdit?: boolean;
};

type Unit = "fte" | "hours";

function fmt(value: number, unit: Unit) {
  if (!value) return "";
  return unit === "hours" ? String(Math.round(value * 10) / 10) : String(Math.round(value * 100) / 100);
}

export function FteCalendarBoard({
  days,
  rows,
  dailyTotals,
  dailyActivityCounts,
  hoursPerDay,
  headcount,
  departmentName,
  label,
}: FteBoardProps) {
  const [unit, setUnit] = useState<Unit>("fte");
  const [hideNonWorking, setHideNonWorking] = useState(false);
  const [groupFilter, setGroupFilter] = useState("all");
  const [focusDate, setFocusDate] = useState<string | null>(null);

  const groups = useMemo(() => [...new Set(rows.map((r) => r.group))].sort(), [rows]);
  const visibleRows = useMemo(
    () => (groupFilter === "all" ? rows : rows.filter((r) => r.group === groupFilter)),
    [rows, groupFilter]
  );
  const visibleIndexes = useMemo(
    () => days.map((day, index) => ({ day, index })).filter(({ day }) => day.working || !hideNonWorking),
    [days, hideNonWorking]
  );
  const scale = unit === "hours" ? hoursPerDay : 1;

  const rowTotals = visibleRows.map((row) =>
    Math.round(row.cells.reduce((sum, cell, index) => (days[index].working ? sum + cell.fte : sum), 0) * 100) / 100
  );
  const visibleFteDays = visibleRows.reduce((sum, row) => sum + row.total_fte_working, 0);
  const workingDayCount = days.filter((d) => d.working).length || 1;
  const avgDaily = Math.round((visibleFteDays / workingDayCount) * 100) / 100;

  return (
    <div className="card">
      <div className="card-pad row-between" style={{ gap: 10, paddingBottom: 12 }}>
        <div>
          <div className="label">FTE calendar · {label}</div>
          <div className="card-sub">
            {visibleRows.length} activit{visibleRows.length === 1 ? "y" : "ies"} · {departmentName} · one column per
            day. A cell shows the FTE that activity needs on that day.
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <div className="segmented" role="group" aria-label="Units">
            <button
              type="button"
              className={`segmented-btn ${unit === "fte" ? "active" : ""}`}
              onClick={() => setUnit("fte")}
            >
              FTE
            </button>
            <button
              type="button"
              className={`segmented-btn ${unit === "hours" ? "active" : ""}`}
              onClick={() => setUnit("hours")}
            >
              Hours
            </button>
          </div>
          <select
            className="select select-sm"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            aria-label="Filter by activity group"
            style={{ maxWidth: 170 }}
          >
            <option value="all">All activity groups</option>
            {groups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
          <label className="check" style={{ fontSize: "0.76rem" }}>
            <input
              type="checkbox"
              checked={hideNonWorking}
              onChange={(e) => setHideNonWorking(e.target.checked)}
            />
            Working days only
          </label>
        </div>
      </div>

      {!visibleRows.length ? (
        <div className="empty">
          No scheduled testing activity in this period for {departmentName}. Widen the scope or pick another month.
        </div>
      ) : (
        <div className="fte-scroll">
          <table className="data fte-matrix">
            <thead>
              <tr>
                <th className="fte-sticky" style={{ minWidth: 260 }}>
                  Activity
                </th>
                {visibleIndexes.map(({ day, index }) => (
                  <th
                    key={day.date}
                    className={`fte-day ${day.working ? "" : "fte-day-off"} ${day.isToday ? "fte-day-today" : ""}`}
                    title={day.holiday ? `${day.date} · ${day.holiday}` : day.date}
                  >
                    <div className="fte-dow">{day.weekdayShort}</div>
                    <div>{day.day}</div>
                  </th>
                ))}
                <th className="num fte-total-col">Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={row.id}>
                  <td className="fte-sticky">
                    <div className="row" style={{ gap: 7, flexWrap: "nowrap" }}>
                      <span className="legend-swatch" style={{ background: row.colour, flex: "0 0 8px" }} />
                      <span style={{ minWidth: 0 }}>
                        <a
                          href={row.href ?? `/calendar?month=${(row.start_date ?? "").slice(0, 7)}&activity=${row.id}`}
                          style={{ color: "var(--text)", fontWeight: 600, textDecoration: "none" }}
                          title={`${row.detail ?? row.activity} — open in the QA calendar`}
                        >
                          {row.activity}
                        </a>
                        <div className="card-sub" style={{ fontSize: "0.68rem", whiteSpace: "nowrap" }}>
                          {row.kind === "release" ? (
                            <span className="badge badge-purple" style={{ fontSize: "0.6rem", marginRight: 5 }}>
                              release
                            </span>
                          ) : null}
                          {row.assignee_name} · {row.group} · {row.effective_fte} FTE
                        </div>
                      </span>
                    </div>
                  </td>
                  {visibleIndexes.map(({ day, index }) => {
                    const cell = row.cells[index];
                    const value = cell.fte * scale;
                    const over = row.cells[index].active && cell.fte > 1.0001;
                    return (
                      <td
                        key={day.date}
                        className={`fte-cell ${cell.active ? "is-active" : ""} ${day.working ? "" : "is-off"} ${
                          day.isToday ? "is-today" : ""
                        } ${over ? "is-over" : ""}`}
                        style={
                          cell.active
                            ? { background: `color-mix(in srgb, ${row.colour} ${Math.min(70, 18 + cell.fte * 26)}%, transparent)` }
                            : undefined
                        }
                        title={`${row.activity} · ${day.date} · ${cell.active ? `${cell.fte} FTE` : "not scheduled"}`}
                      >
                        {cell.active ? fmt(value, unit) : ""}
                      </td>
                    );
                  })}
                  <td className="num fte-total-col">
                    <strong>{fmt(rowTotals[rowIndex] * scale, unit) || "—"}</strong>
                    <div className="card-sub" style={{ fontSize: "0.64rem" }}>
                      {row.covered_days}d
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="fte-sticky">
                  <strong>Daily total</strong>
                  <div className="card-sub" style={{ fontSize: "0.68rem" }}>
                    {headcount} available · {workingDayCount} working days
                  </div>
                </td>
                {visibleIndexes.map(({ day, index }) => {
                  const total = dailyTotals[index] * scale;
                  const over = headcount > 0 && day.working && dailyTotals[index] > headcount;
                  const focused = focusDate === day.date;
                  return (
                    <td
                      key={day.date}
                      className={`fte-cell fte-total ${day.working ? "" : "is-off"} ${over ? "is-over" : ""} ${
                        focused ? "is-focus" : ""
                      }`}
                      onMouseEnter={() => setFocusDate(day.date)}
                      title={`${day.date} · ${dailyTotals[index]} FTE across ${dailyActivityCounts[index]} activit${
                        dailyActivityCounts[index] === 1 ? "y" : "ies"
                      }`}
                    >
                      {total ? fmt(total, unit) : ""}
                    </td>
                  );
                })}
                <td className="num fte-total-col">
                  <strong>{fmt(visibleFteDays * scale, unit)}</strong>
                  <div className="card-sub" style={{ fontSize: "0.64rem" }}>
                    {avgDaily}/day
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="card-pad row" style={{ gap: 14, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
        <span className="card-sub">
          <span className="legend-swatch" style={{ background: "var(--brand)", opacity: 0.35 }} /> scheduled FTE
        </span>
        <span className="card-sub">
          <span className="legend-swatch" style={{ background: "var(--bad)", opacity: 0.6 }} /> over 1.0 FTE for one
          person, or above team headcount for the day
        </span>
        <span className="card-sub" style={{ marginLeft: "auto" }}>
          <Icon name="info" size={13} /> Totals count working days only; weekends and NSW holidays stay visible so
          demand is never silently dropped.
        </span>
      </div>
    </div>
  );
}
