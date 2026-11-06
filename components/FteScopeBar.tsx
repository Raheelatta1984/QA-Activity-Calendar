"use client";

import { useRouter } from "next/navigation";
import { Icon } from "./icons";

export type FteScopeOption = { id: string; name: string };

export function FteScopeBar({
  range,
  monthKey,
  quarter,
  monthOptions,
  quarterOptions,
  departments,
  departmentId,
  groups,
  group,
  people,
  assigneeId,
  testingOnly,
  search,
}: {
  range: "month" | "quarter";
  monthKey: string;
  quarter: number | null;
  monthOptions: { key: string; label: string }[];
  quarterOptions: { value: number; label: string }[];
  departments: FteScopeOption[];
  departmentId: string | null;
  groups: string[];
  group: string | null;
  people: FteScopeOption[];
  assigneeId: string | null;
  testingOnly: boolean;
  search: string;
}) {
  const router = useRouter();

  function update(patch: Record<string, string | null>) {
    const params = new URLSearchParams();
    const current: Record<string, string> = {
      range,
      month: monthKey,
      dept: departmentId ?? "",
      group: group ?? "",
      assignee: assigneeId ?? "",
      testing: testingOnly ? "1" : "0",
      q: search,
    };
    if (range === "quarter" && quarter) current.quarter = String(quarter);
    for (const [key, value] of Object.entries({ ...current, ...patch })) {
      if (value === null || value === "") continue;
      params.set(key, value);
    }
    router.push(`/fte?${params.toString()}`);
  }

  return (
    <div className="card card-pad">
      <div className="filters">
        <div className="field">
          <label htmlFor="fte-range">Period</label>
          <select
            id="fte-range"
            className="select select-sm"
            value={range}
            onChange={(e) => update({ range: e.target.value })}
          >
            <option value="month">Month</option>
            <option value="quarter">Fiscal quarter</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fte-month">{range === "quarter" ? "Month in fiscal year" : "Month"}</label>
          <select
            id="fte-month"
            className="select select-sm"
            value={monthKey}
            onChange={(e) => update({ month: e.target.value })}
          >
            {monthOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {range === "quarter" ? (
          <div className="field">
            <label htmlFor="fte-quarter">Quarter</label>
            <select
              id="fte-quarter"
              className="select select-sm"
              value={quarter ?? 1}
              onChange={(e) => update({ q: e.target.value })}
            >
              {quarterOptions.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="fte-dept">Department</label>
          <select
            id="fte-dept"
            className="select select-sm"
            value={departmentId ?? ""}
            onChange={(e) => update({ dept: e.target.value })}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fte-group">Activity group</label>
          <select
            id="fte-group"
            className="select select-sm"
            value={group ?? ""}
            onChange={(e) => update({ group: e.target.value })}
          >
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fte-assignee">Assignee</label>
          <select
            id="fte-assignee"
            className="select select-sm"
            value={assigneeId ?? ""}
            onChange={(e) => update({ assignee: e.target.value })}
          >
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fte-search">Search activity</label>
          <input
            id="fte-search"
            className="input input-sm"
            defaultValue={search}
            placeholder="e.g. regression"
            onBlur={(e) => update({ q: e.target.value.trim() })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                update({ q: (e.target as HTMLInputElement).value.trim() });
              }
            }}
          />
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <label className="check" style={{ fontSize: "0.78rem", paddingBottom: 6 }}>
            <input type="checkbox" checked={testingOnly} onChange={(e) => update({ testing: e.target.checked ? "1" : "0" })} />
            Testing activities only
          </label>
        </div>
      </div>
      <div className="card-sub" style={{ marginTop: 10 }}>
        <Icon name="info" size={12} /> Scope changes are stored in the URL, so any view can be shared or bookmarked.
        Recording/pipeline rows are excluded while “Testing activities only” is on.
      </div>
    </div>
  );
}
