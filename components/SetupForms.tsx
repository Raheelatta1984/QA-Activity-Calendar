"use client";

import { useActionState, useEffect, useState } from "react";
import { Icon } from "./icons";
import { saveCompanyAction, savePersonAction, type AdminResult } from "@/app/actions/admin";

export type PersonRecord = {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  role: string;
  manager_id: string | null;
  department_id: string | null;
  capacity_hours_day: number;
  active: number;
};

export function PersonForm({
  person,
  people,
  departments,
  onClose,
}: {
  person: PersonRecord | null;
  people: PersonRecord[];
  departments: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<AdminResult, FormData>(savePersonAction, {});
  const [active, setActive] = useState(person ? !!person.active : true);

  useEffect(() => {
    if (state.ok) onClose();
  }, [state.ok, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: "min(620px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{person ? "Edit employee" : "Add employee"}</h2>
            <div className="card-sub">Manage identity, role, reporting line and daily capacity.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <form action={formAction}>
          <div className="modal-body">
            <input type="hidden" name="id" value={person?.id ?? ""} />
            <div className="form-grid">
              <div className="field">
                <label>Full name *</label>
                <input className="input" name="name" defaultValue={person?.name ?? ""} required />
              </div>
              <div className="field">
                <label>Email {person ? "" : "*"}</label>
                <input
                  className="input"
                  type="email"
                  name="email"
                  defaultValue={person?.email ?? ""}
                  required={!person}
                  placeholder={person?.email ? "" : "No address on record — leave blank"}
                />
              </div>
              <div className="field">
                <label>Job title</label>
                <input className="input" name="title" defaultValue={person?.title ?? ""} />
              </div>
              <div className="field">
                <label>Role</label>
                <select className="select" name="role" defaultValue={person?.role ?? "viewer"}>
                  {["viewer", "editor", "manager", "exec", "admin"].map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Department</label>
                <select className="select" name="department_id" defaultValue={person?.department_id ?? ""}>
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Reports to</label>
                <select className="select" name="manager_id" defaultValue={person?.manager_id ?? ""}>
                  <option value="">No manager (top level)</option>
                  {people
                    .filter((p) => p.id !== person?.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.role})
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label>Capacity hours / day</label>
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="24"
                  name="capacity_hours_day"
                  defaultValue={person?.capacity_hours_day ?? 7.6}
                />
              </div>
              <div className="field">
                <label>{person ? "Reset password" : "Initial password"}</label>
                <input className="input" name="password" placeholder={person ? "Leave blank to keep" : "demo1234"} />
              </div>
              <label className="check span-2">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} name="active" />
                Active — inactive people are hidden from assignment lists but keep their history.
              </label>
            </div>
            {state.error ? (
              <div className="banner bad" style={{ marginTop: 10 }}>
                <Icon name="alert" size={15} /> {state.error}
              </div>
            ) : null}
          </div>
          <div className="modal-foot">
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : person ? "Save employee" : "Add employee"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function CompanyForm({
  company,
}: {
  company: { name: string; legal_name: string | null; timezone: string; fiscal_start_month: number };
}) {
  const [state, formAction, pending] = useActionState<AdminResult, FormData>(saveCompanyAction, {});
  return (
    <form action={formAction} className="card-pad">
      <div className="form-grid">
        <div className="field">
          <label>Company name</label>
          <input className="input" name="name" defaultValue={company.name} required />
        </div>
        <div className="field">
          <label>Legal entity</label>
          <input className="input" name="legal_name" defaultValue={company.legal_name ?? ""} />
        </div>
        <div className="field">
          <label>Timezone</label>
          <select className="select" name="timezone" defaultValue={company.timezone}>
            {["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "UTC"].map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Fiscal year starts in</label>
          <select className="select" name="fiscal_start_month" defaultValue={company.fiscal_start_month}>
            {[
              "January",
              "February",
              "March",
              "April",
              "May",
              "June",
              "July",
              "August",
              "September",
              "October",
              "November",
              "December",
            ].map((month, index) => (
              <option key={month} value={index + 1}>
                {month}
              </option>
            ))}
          </select>
        </div>
      </div>
      {state.error ? (
        <div className="banner bad" style={{ marginTop: 10 }}>
          <Icon name="alert" size={15} /> {state.error}
        </div>
      ) : null}
      {state.ok ? (
        <div className="banner good" style={{ marginTop: 10 }}>
          <Icon name="check" size={15} /> Company entity updated.
        </div>
      ) : null}
      <div className="form-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save company"}
        </button>
      </div>
    </form>
  );
}
