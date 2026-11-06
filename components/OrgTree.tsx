"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { movePersonAction } from "@/app/actions/admin";

export type TreeNode = {
  id: string;
  name: string;
  title: string | null;
  role: string;
  colour: string;
  manager_id: string | null;
  department_name: string | null;
  directReports: number;
};

export function OrgTree({ people, canEdit }: { people: TreeNode[]; canEdit: boolean }) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null | undefined>(undefined);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const { childrenOf, roots } = useMemo(() => {
    const childrenOf = new Map<string, TreeNode[]>();
    const ids = new Set(people.map((p) => p.id));
    for (const person of people) {
      const key = person.manager_id && ids.has(person.manager_id) ? person.manager_id : "__root__";
      const list = childrenOf.get(key) ?? [];
      list.push(person);
      childrenOf.set(key, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return { childrenOf, roots: childrenOf.get("__root__") ?? [] };
  }, [people]);

  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  }

  async function drop(managerId: string | null) {
    if (!dragId || !canEdit || pending) return;
    if (dragId === managerId) return;
    setPending(true);
    setMessage(null);
    const result = await movePersonAction(dragId, managerId);
    setPending(false);
    setDropId(undefined);
    setDragId(null);
    if (result?.error) setMessage({ kind: "error", text: result.error });
    else {
      setMessage({ kind: "ok", text: "Reporting line updated — visibility recalculated for the whole sub-tree." });
      router.refresh();
    }
  }

  function renderNode(person: TreeNode, depth: number): React.ReactNode {
    const reports = childrenOf.get(person.id) ?? [];
    const isCollapsed = collapsed.has(person.id);
    return (
      <div className="tree-node" key={person.id}>
        <div
          className={`tree-row ${dragId === person.id ? "dragging" : ""} ${dropId === person.id ? "drop-target" : ""}`}
          draggable={canEdit}
          onDragStart={(e) => {
            setDragId(person.id);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", person.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropId(undefined);
          }}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropId(person.id);
          }}
          onDragLeave={() => setDropId(undefined)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            drop(person.id);
          }}
          title={canEdit ? "Drag onto a manager to restructure" : undefined}
        >
          {canEdit ? <Icon name="drag" size={14} className="tree-grip" /> : null}
          {reports.length ? (
            <button
              className="btn btn-sm btn-ghost"
              style={{ padding: 2 }}
              onClick={() => toggle(person.id)}
              aria-label={isCollapsed ? "Expand" : "Collapse"}
            >
              <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={13} />
            </button>
          ) : (
            <span style={{ width: 18 }} />
          )}
          <span className="avatar" style={{ background: person.colour }}>
            {person.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
          </span>
          <div style={{ minWidth: 0 }} className="grow">
            <div className="tree-name">
              {person.name}
              <span className={`badge ${person.role === "admin" ? "badge-purple" : person.role === "exec" ? "badge-amber" : "badge-slate"}`} style={{ marginLeft: 8 }}>
                {person.role}
              </span>
            </div>
            <div className="tree-meta">
              {person.title ?? "—"}
              {person.department_name ? ` · ${person.department_name}` : ""}
              {reports.length ? ` · ${reports.length} direct report${reports.length === 1 ? "" : "s"}` : ""}
            </div>
          </div>
          <span className="badge badge-slate">{depth === 0 ? "root" : `L${depth}`}</span>
        </div>
        {reports.length && !isCollapsed ? (
          <div className="tree-children">{reports.map((child) => renderNode(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="banner info">
        <Icon name="users" size={15} />
        <span>
          Visibility is downward-only: a person sees their own sub-tree and never their manager or anyone above.
          Drag any row onto a new manager to move the whole sub-tree.
        </span>
      </div>

      {message ? (
        <div className={`banner ${message.kind === "ok" ? "good" : "bad"}`}>
          <Icon name={message.kind === "ok" ? "check" : "alert"} size={15} /> {message.text}
        </div>
      ) : null}

      <div className="tree">
        {roots.map((person) => renderNode(person, 0))}
        {!roots.length ? <div className="empty">No people configured yet.</div> : null}
      </div>

      {canEdit ? (
        <div
          className={`tree-drop-hint ${dropId === null ? "drop-target" : ""}`}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            setDropId(null);
          }}
          onDragLeave={() => setDropId(undefined)}
          onDrop={(e) => {
            e.preventDefault();
            drop(null);
          }}
        >
          Drop here to detach a person from any manager (top-level reporting line)
        </div>
      ) : null}
    </div>
  );
}
