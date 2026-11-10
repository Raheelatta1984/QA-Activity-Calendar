"use client";

import { useState } from "react";
import { Icon } from "./icons";
import { PersonForm, type PersonRecord } from "./SetupForms";
import { togglePersonActiveAction } from "@/app/actions/admin";

export function PeoplePanel({
  people,
  departments,
  canEdit,
}: {
  people: PersonRecord[];
  departments: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<PersonRecord | "new" | null>(null);
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";

  return (
    <div className="card-pad stack">
      <div className="row-between">
        <div className="card-sub">{people.length} employees · roles control what each person can see and change.</div>
        {canEdit ? (
          <button className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} /> Add employee
          </button>
        ) : null}
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Department</th>
              <th>Reports to</th>
              <th className="num">Hours/day</th>
              <th>Status</th>
              {canEdit ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id}>
                <td>
                  <strong>{person.name}</strong>
                  <div className="card-sub">{person.title ?? "—"}</div>
                </td>
                <td className="muted mono" style={{ fontSize: "0.74rem" }}>{person.email ?? "— (linked identity)"}</td>
                <td>
                  <span className={`badge ${person.role === "admin" ? "badge-purple" : person.role === "exec" ? "badge-amber" : person.role === "manager" ? "badge-blue" : "badge-slate"}`}>
                    {person.role}
                  </span>
                </td>
                <td className="muted">{departments.find((d) => d.id === person.department_id)?.name ?? "—"}</td>
                <td className="muted">{nameOf(person.manager_id)}</td>
                <td className="num">{person.capacity_hours_day}</td>
                <td>
                  <span className={`badge ${person.active ? "badge-green" : "badge-slate"}`}>
                    {person.active ? "active" : "inactive"}
                  </span>
                </td>
                {canEdit ? (
                  <td className="right nowrap">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(person)}>
                      <Icon name="edit" size={12} /> Edit
                    </button>
                    <form action={togglePersonActiveAction} style={{ display: "inline" }}>
                      <input type="hidden" name="id" value={person.id} />
                      <button className="btn btn-sm btn-ghost" type="submit">
                        {person.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <PersonForm
          person={editing === "new" ? null : editing}
          people={people}
          departments={departments}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
