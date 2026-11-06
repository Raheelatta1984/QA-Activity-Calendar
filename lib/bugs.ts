import { all, get } from "./db";
import type { Viewer } from "./access";

export type BugLink = { service_id: string; service_name: string; status: string };

export type BugView = {
  id: string;
  bug_key: string;
  title: string;
  severity: string;
  status: string;
  reported_date: string | null;
  resolved_date: string | null;
  reported_by: string | null;
  reporter_name: string | null;
  activity_id: string | null;
  activity_name: string | null;
  notes: string | null;
  is_demo: number;
  links: BugLink[];
  derived_status: "Open" | "Fixed" | "Closed";
};

/**
 * Overall status is derived from the per-service links:
 *  - all links Closed            → Closed
 *  - every link Fixed or Closed  → Fixed (still needs verification)
 *  - any link Open               → Open
 * That means one outstanding link keeps a shared bug open.
 */
export function deriveStatus(baseStatus: string, links: BugLink[]): "Open" | "Fixed" | "Closed" {
  if (!links.length) {
    return baseStatus === "Closed" ? "Closed" : baseStatus === "Fixed" ? "Fixed" : "Open";
  }
  if (links.every((l) => l.status === "Closed")) return "Closed";
  if (links.every((l) => l.status === "Fixed" || l.status === "Closed")) return "Fixed";
  return "Open";
}

export function listBugs(viewer: Viewer): BugView[] {
  const bugs = all<any>(
    `SELECT b.*, p.name AS reporter_name, a.activity AS activity_name
       FROM bugs b
       LEFT JOIN people p ON p.id = b.reported_by
       LEFT JOIN activities a ON a.id = b.activity_id
      ORDER BY b.reported_date DESC, b.bug_key`
  );
  const links = all<any>(
    `SELECT l.bug_id, l.service_id, l.status, s.name AS service_name
       FROM bug_service_links l
       LEFT JOIN backend_services s ON s.id = l.service_id`
  );
  const byBug = new Map<string, BugLink[]>();
  for (const link of links) {
    const arr = byBug.get(link.bug_id) ?? [];
    arr.push({ service_id: link.service_id, service_name: link.service_name ?? "Unknown service", status: link.status });
    byBug.set(link.bug_id, arr);
  }
  return bugs.map((bug) => {
    const bugLinks = byBug.get(bug.id) ?? [];
    return { ...bug, links: bugLinks, derived_status: deriveStatus(bug.status, bugLinks) };
  });
}

export function bugTotals(bugs: BugView[]) {
  return bugs.reduce(
    (acc, bug) => {
      acc.reported += 1;
      if (bug.derived_status === "Closed") acc.closed += 1;
      else if (bug.derived_status === "Fixed") acc.fixed += 1;
      else acc.outstanding += 1;
      return acc;
    },
    { reported: 0, fixed: 0, closed: 0, outstanding: 0 }
  );
}

export function bugProgressByActivity(bugs: BugView[]) {
  const map = new Map<string, { reported: number; fixed: number; closed: number; outstanding: number }>();
  for (const bug of bugs) {
    if (!bug.activity_id) continue;
    const entry = map.get(bug.activity_id) ?? { reported: 0, fixed: 0, closed: 0, outstanding: 0 };
    entry.reported += 1;
    if (bug.derived_status === "Closed") entry.closed += 1;
    else if (bug.derived_status === "Fixed") entry.fixed += 1;
    else entry.outstanding += 1;
    map.set(bug.activity_id, entry);
  }
  return map;
}

export function listServices() {
  return all<{ id: string; name: string; application_name: string }>(
    `SELECT s.id, s.name, a.name AS application_name
       FROM backend_services s LEFT JOIN applications a ON a.id = s.application_id
      ORDER BY a.name, s.name`
  );
}

export function bugById(id: string) {
  return get<any>(
    `SELECT b.*, p.name AS reporter_name, a.activity AS activity_name FROM bugs b
      LEFT JOIN people p ON p.id = b.reported_by
      LEFT JOIN activities a ON a.id = b.activity_id WHERE b.id = ?`,
    id
  );
}
