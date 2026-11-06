"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { ActivityForm } from "./ActivityForm";
import type { ClientActivity, ClientDepartment, ClientPerson } from "./types";

export function DashboardActions({
  activities,
  people,
  departments,
  canEdit,
}: {
  activities: ClientActivity[];
  people: ClientPerson[];
  departments: ClientDepartment[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClientActivity | null>(null);

  return (
    <div className="row">
      <Link className="btn btn-sm" href="/calendar">
        <Icon name="calendar" size={14} /> Open calendar
      </Link>
      {canEdit ? (
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Icon name="plus" size={14} /> Log activity
        </button>
      ) : null}
      {open ? (
        <ActivityForm
          activity={editing}
          people={people}
          departments={departments}
          path="/"
          canEdit={canEdit}
          onClose={() => {
            setOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
      <span className="hide-sm card-sub" style={{ marginLeft: 6 }}>
        {activities.length} tracked
      </span>
    </div>
  );
}
